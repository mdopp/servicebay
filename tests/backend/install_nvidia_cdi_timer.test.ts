/**
 * install-nvidia-cdi: the timer has to STOP once there is nothing left to do
 * (#2668).
 *
 * The bug this locks down: `install-nvidia-cdi.timer` uses
 * `OnUnitInactiveSec=60s`, and systemd never stops such a timer by itself. The
 * done-marker guard used to sit on `install-nvidia-cdi.service` as a
 * `ConditionPathExists`, which only made each fire a no-op *for the service* —
 * systemd still logged `skipped, unmet condition` every 60 s, for ever. On the
 * reference box that was 1432 journal lines a day, ~125k lines after the work
 * had actually finished in June, crowding out the lines an operator later needs
 * (#2659).
 *
 * So the guards moved into `/usr/local/bin/install-nvidia-cdi.sh`, which can do
 * what a unit condition cannot: disable the timer. This suite drives that script
 * for real — the units and the script are extracted from the Butane asset,
 * every absolute path is rewritten into a temp root, and the handful of host
 * binaries it calls (systemctl, nvidia-ctk, modprobe, the status helpers) are
 * stubbed — so these are behavioural assertions, not a grep over the asset.
 *
 * The structural half (which `ConditionPathExists` lines exist on which unit) is
 * asserted too, because that is the half that keeps a *rebooted* box quiet: a
 * unit condition is evaluated when the unit starts, not on every fire.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, it, expect, beforeAll } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUTANE_TEMPLATE = path.join(
  REPO_ROOT, 'tools', 'sb', 'internal', 'build', 'assets', 'fedora-coreos.bu',
);

const CDI_SCRIPT = '/usr/local/bin/install-nvidia-cdi.sh';
const CDI_SERVICE = '/etc/systemd/system/install-nvidia-cdi.service';
const CDI_TIMER = '/etc/systemd/system/install-nvidia-cdi.timer';

interface ButaneFile {
  path: string;
  contents?: { inline?: string };
  target?: string;
}

/** Parse the raw Butane asset (same stub trick as install_quadlet_scope.test.ts). */
function butaneFiles(): ButaneFile[] {
  let template = fs.readFileSync(BUTANE_TEMPLATE, 'utf8');
  // Column-0 `${VAR}` placeholders expand to multi-line content at render time
  // and break the block-scalar parser raw. None of them is a unit.
  template = template.replace(/^\$\{[A-Z_]+\}[ \t]*$/gm, '          "STUBBED_INTERPOLATION"');
  const parsed = yaml.load(template) as { storage?: { files?: ButaneFile[] } } | null;
  return parsed?.storage?.files ?? [];
}

function inlineAt(p: string): string {
  const file = butaneFiles().find((f) => f.path === p);
  if (!file?.contents?.inline) throw new Error(`no inline contents declared at ${p} in fedora-coreos.bu`);
  return file.contents.inline;
}

/** `ConditionPathExists=` values declared in a unit body's `[Unit]` section. */
function conditionsOf(body: string): string[] {
  const out: string[] = [];
  let inUnit = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[') && line.endsWith(']')) { inUnit = line === '[Unit]'; continue; }
    if (!inUnit || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('ConditionPathExists=')) out.push(line.slice('ConditionPathExists='.length).trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runtime harness: run the real script against a fake root.
// ---------------------------------------------------------------------------

const REAL_TOOLS = ['cat', 'grep', 'seq', 'touch', 'mkdir', 'tee', 'rm', 'nohup', 'sleep'];
/** Stubs that must NOT do the real thing (or do not exist on a CI runner). */
const STUBS: Record<string, string> = {
  // Record the invocation instead of talking to a real init system.
  systemctl: 'echo "$*" >> "$SB_TEST_ROOT/systemctl.log"',
  'update-install-status.sh': 'echo "$*" >> "$SB_TEST_ROOT/status.log"',
  'append-install-log.sh': 'echo "$*" >> "$SB_TEST_ROOT/append.log"',
  'nvidia-ctk': 'echo "$*" >> "$SB_TEST_ROOT/nvidia-ctk.log"',
  modprobe: 'exit 0',
  pgrep: 'exit 1',
  akmods: 'exit 0',
};

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  root: string;
  systemctl: string;
  exists(rel: string): boolean;
  read(rel: string): string;
}

interface RunOpts {
  /** Marker files (relative to the fake root) to create before the run. */
  markers?: string[];
  /** Content for the attempts counter, e.g. '60'. */
  attempts?: string;
  /** true → /proc/modules lists the nvidia kmod. */
  kmodLoaded?: boolean;
  /** Mutate the script text before running (used to prove a guard is load-bearing). */
  mutate?: (script: string) => string;
}

function runCdiScript(opts: RunOpts = {}): RunResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-nvidia-cdi-'));
  const bin = path.join(root, 'bin');
  for (const dir of ['bin', 'var/lib', 'var/log', 'var/home/core/.config/containers/splash', 'proc', 'etc', 'mnt/data']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }

  for (const tool of REAL_TOOLS) {
    const real = execFileSync('bash', ['-lc', `command -v ${tool}`], { encoding: 'utf-8' }).trim();
    fs.symlinkSync(real, path.join(bin, tool));
  }
  for (const [name, body] of Object.entries(STUBS)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }

  fs.writeFileSync(
    path.join(root, 'proc', 'modules'),
    opts.kmodLoaded
      ? 'nvidia 12345 0 - Live 0x0000000000000000 (POE)\nsnd 1 0 - Live 0x0\n'
      : 'snd 1 0 - Live 0x0\n',
  );
  for (const marker of opts.markers ?? []) fs.writeFileSync(path.join(root, marker), '');
  if (opts.attempts !== undefined) {
    fs.writeFileSync(path.join(root, 'var/lib/install-nvidia-cdi-attempts'), `${opts.attempts}\n`);
  }

  // Rewrite the script's absolute paths into the fake root. Longest-prefix
  // first so /usr/local/bin/ never gets half-rewritten by /usr/bin/.
  let script = inlineAt(CDI_SCRIPT).replaceAll('${HOST_USER}', 'core');
  for (const [from, to] of [
    ['/usr/local/bin/', `${bin}/`],
    ['/usr/sbin/', `${bin}/`],
    ['/usr/bin/', `${bin}/`],
    ['/var/lib/', `${root}/var/lib/`],
    ['/var/home/', `${root}/var/home/`],
    ['/var/log/', `${root}/var/log/`],
    ['/proc/modules', `${root}/proc/modules`],
    ['/etc/cdi', `${root}/etc/cdi`],
    ['/mnt/data/', `${root}/mnt/data/`],
  ] as const) {
    script = script.replaceAll(from, to);
  }
  if (opts.mutate) script = opts.mutate(script);

  const scriptPath = path.join(root, 'install-nvidia-cdi.sh');
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  const result = spawnSync('bash', [scriptPath], {
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, SB_TEST_ROOT: root, PATH: `${bin}:${process.env.PATH ?? ''}` },
  });

  const read = (rel: string) => {
    const p = path.join(root, rel);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  };
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    root,
    systemctl: read('systemctl.log'),
    exists: (rel: string) => fs.existsSync(path.join(root, rel)),
    read,
  };
}

const DISABLE_TIMER = 'disable --now install-nvidia-cdi.timer';

function bashAvailable(): boolean {
  return spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0;
}

describe('install-nvidia-cdi.sh stops its own timer (#2668)', () => {
  const t = bashAvailable() ? it : it.skip;

  t('a fire on an already-done box disables the timer instead of no-opping for ever', () => {
    const r = runCdiScript({ markers: ['var/lib/install-nvidia-cdi-done'] });
    expect(r.status).toBe(0);
    expect(r.systemctl).toContain(DISABLE_TIMER);
  });

  t('without the stop_timer call an already-done fire leaves the timer running (guard is load-bearing)', () => {
    // Mutation check: neuter the guard's effect and the assertion above must
    // fail. Without this, a refactor could drop the disable and the test above
    // would still pass on some other code path.
    const r = runCdiScript({
      markers: ['var/lib/install-nvidia-cdi-done'],
      mutate: (s) => s.replace(/^(\s*)stop_timer$/gm, '$1:'),
    });
    expect(r.status).toBe(0);
    expect(r.systemctl).not.toContain(DISABLE_TIMER);
  });

  t('the first run still works: CDI is generated, markers written, timer stopped', () => {
    const r = runCdiScript({ markers: ['var/lib/install-nvidia-driver-done'], kmodLoaded: true });
    expect(r.status).toBe(0);
    expect(r.read('nvidia-ctk.log')).toContain('cdi generate');
    expect(r.exists('var/lib/install-nvidia-cdi-done')).toBe(true);
    expect(r.exists('mnt/data/servicebay/.has-nvidia-cdi')).toBe(true);
    expect(r.exists('var/lib/installation-ready')).toBe(true);
    // The attempt counter is scratch state, not a marker to leave behind.
    expect(r.exists('var/lib/install-nvidia-cdi-attempts')).toBe(false);
    expect(r.systemctl).toContain(DISABLE_TIMER);
  });
});

describe('install-nvidia-cdi.sh gives up on a driver that never arrives (#2668)', () => {
  const t = bashAvailable() ? it : it.skip;

  t('under budget: counts the attempt, stays quiet-ish, leaves the timer alone', () => {
    const r = runCdiScript({ attempts: '3' });
    expect(r.status).toBe(0);
    expect(r.read('var/lib/install-nvidia-cdi-attempts').trim()).toBe('4');
    expect(r.stdout).toContain('driver not layered yet');
    expect(r.systemctl).not.toContain(DISABLE_TIMER);
    expect(r.exists('var/lib/install-nvidia-cdi-gave-up')).toBe(false);
  });

  t('over budget: says once that it gave up, stops the timer, and unblocks the boot', () => {
    const r = runCdiScript({ attempts: '60' });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/giving up after 60 attempts/);
    expect(r.exists('var/lib/install-nvidia-cdi-gave-up')).toBe(true);
    expect(r.systemctl).toContain(DISABLE_TIMER);
    // A GPU that is not coming must not strand the install at
    // "Waiting for NVIDIA kernel module" for ever.
    expect(r.exists('var/lib/installation-ready')).toBe(true);
  });

  t('once means once: a later fire after giving up says nothing and just re-stops the timer', () => {
    const r = runCdiScript({ attempts: '99', markers: ['var/lib/install-nvidia-cdi-gave-up'] });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/giving up/);
    expect(r.systemctl).toContain(DISABLE_TIMER);
  });
});

describe('fedora-coreos.bu unit definitions for install-nvidia-cdi (#2668)', () => {
  let service = '';
  let timer = '';
  beforeAll(() => {
    service = inlineAt(CDI_SERVICE);
    timer = inlineAt(CDI_TIMER);
  });

  it('the timer refuses to start once CDI is done or given up, so a reboot stays quiet', () => {
    expect(conditionsOf(timer)).toEqual([
      '!/var/lib/install-nvidia-cdi-done',
      '!/var/lib/install-nvidia-cdi-gave-up',
    ]);
  });

  it('the service carries no ConditionPathExists — that is what made the timer immortal', () => {
    // A condition-skipped fire never runs the script, so the script never gets
    // to disable the timer, and systemd logs "skipped, unmet condition" every
    // 60 s for ever. The guards belong in the script.
    expect(conditionsOf(service)).toEqual([]);
  });

  it('the timer still drives the service on the same 60 s cadence for the first run', () => {
    expect(timer).toContain('OnBootSec=30s');
    expect(timer).toContain('OnUnitInactiveSec=60s');
    expect(timer).toContain('Unit=install-nvidia-cdi.service');
  });
});

// The retrofit path used to be `scripts/enable-nvidia.sh`, asserted here. The
// script was deleted in #2729 (nothing in the shipping tree ran it) and its
// know-how now lives in the assist `recipe-retrofit-nvidia-gpu-on-a-running-box`
// — including the step this test guarded: after generating CDI by hand, disable
// `install-nvidia-cdi.timer`, or it keeps logging a line a minute for work that
// is already done (#2668).
