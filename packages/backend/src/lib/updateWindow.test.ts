/**
 * #2515 — `AutoUpdate=registry` never fired because the update window
 * enabled the SYSTEM `podman-auto-update.timer` while every ServiceBay
 * container is a ROOTLESS Quadlet owned by the user manager.
 *
 * These tests deliberately do NOT assert "some command string was issued".
 * They model systemd's two managers (system vs. user) and their unit search
 * paths, then check **reachability**: the manager that owns the units
 * carrying `AutoUpdate=registry` must be the same manager that runs the
 * timer we enable, and must be the same manager that reads our drop-in.
 * `podman auto-update` only ever sees the container store of the user it
 * runs as, so same-manager is exactly the property that makes the label
 * effective.
 */
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import type { Executor } from './interfaces';
import type { AppConfig } from './config';
import { applyUpdateWindow, applyLocks } from './updateWindow';
import { getLocalSystemdDir } from './dirs';
import { generateBundleStackArtifacts, type ServiceBundle } from './unmanaged/bundleShared';

type Scope = 'user' | 'system';

const HOME = os.homedir();

function expand(p: string): string {
  return p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p;
}

/**
 * systemd's unit search paths, per manager. A drop-in is only merged into a
 * unit if it sits under the search path of the manager that loaded it.
 * (`man systemd.unit`, "Table 1/2 — Load path".)
 */
const UNIT_SEARCH_PATH: Record<Scope, string[]> = {
  user: [expand('~/.config/systemd/user'), expand('~/.local/share/systemd/user'), '/etc/systemd/user', '/usr/lib/systemd/user'],
  system: ['/etc/systemd/system', '/run/systemd/system', '/usr/lib/systemd/system'],
};

/**
 * Quadlet's generator directories, per manager (`man quadlet`). A `.kube`
 * unit dropped here is turned into a `.service` by the generator of THAT
 * manager, and its containers land in THAT user's podman store.
 */
const QUADLET_DIRS: Record<Scope, string[]> = {
  user: [expand('~/.config/containers/systemd'), expand('~/.local/share/containers/systemd')],
  system: ['/etc/containers/systemd', '/usr/share/containers/systemd'],
};

function scopeOf(dirs: Record<Scope, string[]>, target: string): Scope | null {
  const abs = expand(target);
  for (const scope of ['user', 'system'] as Scope[]) {
    if (dirs[scope].some(d => abs === d || abs.startsWith(`${d}/`))) return scope;
  }
  return null;
}

interface SystemctlCall {
  scope: Scope;
  verb: string;
  unit: string | undefined;
  raw: string;
}

/** Parse the `systemctl …` tail of a recorded shell command. */
function parseSystemctl(raw: string): SystemctlCall | null {
  const idx = raw.indexOf('systemctl ');
  if (idx === -1) return null;
  const tokens = raw.slice(idx).trim().split(/\s+/);
  const rest = tokens.slice(1);
  const scope: Scope = rest[0] === '--user' ? 'user' : 'system';
  const args = rest.filter(t => !t.startsWith('--'));
  return { scope, verb: args[0], unit: args[1], raw };
}

function makeExecutor() {
  const commands: string[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const executor: Executor = {
    exec: vi.fn(async (command: string) => {
      commands.push(command);
      return { stdout: '', stderr: '' };
    }),
    execArgv: vi.fn(async (argv: string[]) => {
      commands.push(argv.join(' '));
      return { stdout: '', stderr: '' };
    }),
    spawn: vi.fn(),
    readFile: vi.fn(async () => ''),
    writeFile: vi.fn(async (p: string, content: string) => {
      writes.push({ path: p, content });
    }),
    exists: vi.fn(async () => true),
    mkdir: vi.fn(async () => undefined),
    readdir: vi.fn(async () => []),
    rm: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
  } as unknown as Executor;
  const calls = () => commands.map(parseSystemctl).filter((c): c is SystemctlCall => c !== null);
  const timerCalls = () => calls().filter(c => c.unit === 'podman-auto-update.timer');
  return { executor, commands, writes, timerCalls };
}

const WINDOW: NonNullable<AppConfig['updateWindow']> = {
  enabled: true,
  days: ['Sat', 'Sun'],
  startTime: '03:00',
  lengthMinutes: 120,
  applyTo: { os: true, containers: true, servicebay: false },
};

const BUNDLE: ServiceBundle = {
  id: 'bundle-001',
  displayName: 'Example App',
  derivedName: 'example-app',
  nodeName: 'Local',
  severity: 'info',
  hints: [],
  validations: [],
  services: [],
  containers: [{ id: 'abc123', name: 'api', image: 'ghcr.io/example/api:latest', ports: [] }],
  ports: [],
  assets: [],
  graph: [],
};

/** The manager that owns every unit ServiceBay stamps `AutoUpdate=registry` into. */
const AUTO_UPDATE_UNIT_SCOPE = scopeOf(QUADLET_DIRS, getLocalSystemdDir());

describe('podman auto-update reachability (#2515)', () => {
  it('installs AutoUpdate=registry units into the rootless (user) quadlet scope', () => {
    // Real generator, same `[Kube]` body install/runner.ts writes.
    const { kubeUnit } = generateBundleStackArtifacts(BUNDLE, 'demo');
    expect(kubeUnit).toContain('AutoUpdate=registry');
    expect(AUTO_UPDATE_UNIT_SCOPE).toBe('user');
  });

  it('enables the timer in the SAME manager that owns those units', async () => {
    const { executor, timerCalls } = makeExecutor();
    await applyUpdateWindow(executor, WINDOW);

    const enables = timerCalls().filter(c => c.verb === 'enable');
    expect(enables).toHaveLength(1);
    // The reachability assertion: `podman auto-update` run by this manager
    // queries this user's container store, which is where the units above
    // put their containers. A system-scope enable would query root's store.
    expect(enables[0].scope).toBe(AUTO_UPDATE_UNIT_SCOPE);
    expect(timerCalls().some(c => c.verb === 'enable' && c.scope === 'system')).toBe(false);
  });

  it('writes the window drop-in into the user manager unit search path', async () => {
    const { executor, writes } = makeExecutor();
    await applyUpdateWindow(executor, WINDOW);

    const dropIn = writes.find(w => w.path.includes('podman-auto-update.timer.d'));
    expect(dropIn).toBeDefined();
    expect(scopeOf(UNIT_SEARCH_PATH, path.dirname(dropIn!.path))).toBe(AUTO_UPDATE_UNIT_SCOPE);
    expect(path.basename(path.dirname(dropIn!.path))).toBe('podman-auto-update.timer.d');
    expect(dropIn!.content).toContain('OnCalendar=Sat,Sun *-*-* 03:00:00 UTC');
    // The zeroing line is what stops the packaged daily schedule surviving.
    expect(dropIn!.content).toContain('\nOnCalendar=\n');
  });

  it('exports XDG_RUNTIME_DIR for every user-scope systemctl call', async () => {
    const { executor, commands } = makeExecutor();
    await applyUpdateWindow(executor, WINDOW);
    const userCalls = commands.filter(c => c.includes('systemctl --user'));
    expect(userCalls.length).toBeGreaterThan(0);
    for (const c of userCalls) expect(c).toContain('XDG_RUNTIME_DIR');
  });
});

describe('lockPodmanTimer acts at the level it enables (#2515)', () => {
  it('disables and masks the timer in the same scope the window enables it', async () => {
    const enabling = makeExecutor();
    await applyUpdateWindow(enabling.executor, WINDOW);
    const enableScope = enabling.timerCalls().find(c => c.verb === 'enable')!.scope;

    const locking = makeExecutor();
    await applyLocks(locking.executor);
    const lockVerbs = locking.timerCalls().filter(c => c.scope === enableScope).map(c => c.verb);

    expect(lockVerbs).toContain('disable');
    expect(lockVerbs).toContain('mask');
    // Nothing is left running: no enable anywhere on the lock path.
    expect(locking.timerCalls().some(c => c.verb === 'enable')).toBe(false);
    // And the drop-in that carried our schedule is removed from the same
    // search path it was written to, so an unmask later can't resurrect it.
    expect(locking.commands.some(c => /^rm -f .*podman-auto-update\.timer\.d/.test(c))).toBe(true);
  });

  it('locks the same scope when the window opts containers out', async () => {
    const { executor, timerCalls } = makeExecutor();
    await applyUpdateWindow(executor, { ...WINDOW, applyTo: { os: true, containers: false, servicebay: false } });
    const inScope = timerCalls().filter(c => c.scope === AUTO_UPDATE_UNIT_SCOPE);
    expect(inScope.map(c => c.verb)).toContain('disable');
    expect(inScope.map(c => c.verb)).toContain('mask');
    expect(inScope.some(c => c.verb === 'enable')).toBe(false);
  });
});

describe('the legacy system-scope timer is retired, not maintained (#2515)', () => {
  async function assertRetired(run: (e: Executor) => Promise<void>) {
    const { executor, commands, timerCalls, writes } = makeExecutor();
    await run(executor);

    expect(commands).toContain('sudo rm -f /etc/systemd/system/podman-auto-update.timer.d/55-servicebay-window.conf');
    const system = timerCalls().filter(c => c.scope === 'system');
    expect(system.map(c => c.verb)).toContain('disable');
    expect(system.some(c => c.verb === 'enable')).toBe(false);
    // Nothing ServiceBay-owned is written under the system search path.
    expect(writes.some(w => scopeOf(UNIT_SEARCH_PATH, path.dirname(w.path)) === 'system')).toBe(false);
  }

  it('removes the old /etc drop-in and disables the root timer when a window is applied', async () => {
    await assertRetired(e => applyUpdateWindow(e, WINDOW));
  });

  it('removes the old /etc drop-in and disables the root timer when locks are applied', async () => {
    await assertRetired(e => applyLocks(e));
  });
});
