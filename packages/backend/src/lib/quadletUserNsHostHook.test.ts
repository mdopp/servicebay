/**
 * #2808 — the HOST half of the UserNS reconcile.
 *
 * Two things are worth testing here, and neither is "some command was issued":
 *
 *   1. `renderQuadletSelfhealHook` — the pure quadlet edit, including the
 *      idempotency that keeps a boot loop from stacking `ExecStartPre=` lines.
 *   2. `installQuadletUserNsHostHook` against a fake box that really applies the
 *      atomic `sh -c` write, so a second run reads back what the first wrote.
 *
 * The self-heal script itself is bash and is asserted against `fedora-coreos.bu`
 * in `tests/backend/dockerfile_runtime_user.test.ts`; what this file pins about
 * it is the two properties that make it safe to wire WITHOUT a leading `-`:
 * it derives the uid rather than hard-coding one, and it converges (the
 * "already correct" guard that stops the deliberate exit 1 from looping).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Executor } from './interfaces';
import {
  USERNS_SELFHEAL_EXEC_START_PRE,
  USERNS_SELFHEAL_PATH,
  USERNS_SELFHEAL_SCRIPT,
  installQuadletUserNsHostHook,
  renderQuadletSelfhealHook,
} from './quadletUserNsHostHook';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

/** The shape Ignition wrote BEFORE #2808 — no userns hook in [Service]. */
const QUADLET = `[Unit]
Description=ServiceBay Rootless Management Interface

[Container]
Image=ghcr.io/mdopp/servicebay:latest
ContainerName=servicebay
AutoUpdate=registry

[Service]
ExecStartPre=-/bin/bash /usr/local/bin/servicebay-relabel-selfheal.sh
Restart=always

[Install]
WantedBy=default.target
`;

/** Recover the argv from a `shellQuoteAll`-produced string, like `sh` would. */
function shellSplit(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === ' ') {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      i++;
      continue;
    }
    started = true;
    if (c === "'") {
      i++;
      while (i < cmd.length && cmd[i] !== "'") cur += cmd[i++];
      i++;
      continue;
    }
    if (c === '\\') {
      cur += cmd[i + 1];
      i += 2;
      continue;
    }
    cur += c;
    i++;
  }
  if (started) out.push(cur);
  return out;
}

interface FakeBox {
  quadlet: string | null;
  script: string | null;
  files: Record<string, string>;
  argv: string[][];
  executor: Executor;
}

function makeBox(opts: { quadlet?: string | null; script?: string | null } = {}): FakeBox {
  const box: FakeBox = {
    quadlet: opts.quadlet === undefined ? QUADLET : opts.quadlet,
    script: opts.script ?? null,
    files: {},
    argv: [],
    executor: null as unknown as Executor,
  };
  box.executor = {
    readFile: async (p: string) => {
      if (p === USERNS_SELFHEAL_PATH) {
        if (box.script === null) throw new Error('File not found');
        return box.script;
      }
      if (box.quadlet === null) throw new Error('File not found');
      return box.quadlet;
    },
    writeFile: async (p: string, content: string) => {
      box.files[p] = content;
    },
    execSafe: async (argv: string[]) => {
      box.argv.push(argv);
      // `install <tmp> <final>` is what actually lands the script on the host.
      if (argv[0] === 'install') box.script = box.files[argv[argv.length - 2]] ?? null;
      return { stdout: '', stderr: '', code: 0 };
    },
    exec: async (cmd: string) => {
      // The only shell call this module makes is the atomic quadlet write:
      // `sh -c <script> sh <content>`. Apply it to the fake box.
      const parts = shellSplit(cmd);
      expect(parts[0]).toBe('sh');
      box.quadlet = parts[4];
      return { stdout: '', stderr: '' };
    },
  } as unknown as Executor;
  return box;
}

const hookLines = (q: string): string[] => q.split('\n').filter(l => l.includes(USERNS_SELFHEAL_PATH));

describe('quadletUserNsHostHook — renderQuadletSelfhealHook (pure)', () => {
  it('wires the self-heal as the FIRST ExecStartPre in [Service]', () => {
    const next = renderQuadletSelfhealHook(QUADLET)!;
    const lines = next.split('\n');
    expect(lines[lines.indexOf('[Service]') + 1]).toBe(USERNS_SELFHEAL_EXEC_START_PRE);
    // A wrong uid mapping makes the relabel self-heal pointless, so ours runs
    // ahead of it — but it must not displace it.
    expect(next).toContain('ExecStartPre=-/bin/bash /usr/local/bin/servicebay-relabel-selfheal.sh');
  });

  it('wires it WITHOUT a leading `-`', () => {
    // The script's exit 1 IS the mechanism (it aborts a start whose podman argv
    // was baked before the quadlet was fixed). `-` would swallow it and the box
    // would come up mapping-less again — that is #2805.
    expect(USERNS_SELFHEAL_EXEC_START_PRE.startsWith('ExecStartPre=/bin/bash ')).toBe(true);
  });

  it('returns null once the line is there (no second copy on the next boot)', () => {
    const once = renderQuadletSelfhealHook(QUADLET)!;
    expect(renderQuadletSelfhealHook(once)).toBeNull();
    expect(hookLines(once)).toHaveLength(1);
  });

  it('leaves a quadlet with no [Service] section alone', () => {
    expect(renderQuadletSelfhealHook('[Unit]\nDescription=x\n')).toBeNull();
  });
});

describe('quadletUserNsHostHook — the script itself', () => {
  it('derives the uid from the image instead of hard-coding one', () => {
    // A hard-coded uid is the failure #2788 was written to avoid: the host half
    // and the image half would then have to be edited in lockstep, by hand.
    expect(USERNS_SELFHEAL_SCRIPT).toMatch(/podman image inspect .*Config\.User/);
    expect(USERNS_SELFHEAL_SCRIPT).toMatch(/keep-id:uid=\$UID_WANT,gid=\$GID_WANT/);
    expect(USERNS_SELFHEAL_SCRIPT).not.toMatch(/keep-id:uid=\d/);
  });

  it('short-circuits when the mapping is already correct', () => {
    // This guard is what makes the deliberate `exit 1` converge in exactly one
    // restart instead of looping forever.
    expect(USERNS_SELFHEAL_SCRIPT).toContain('[ "$HAVE" = "$WANT_CMP" ] && exit 0');
    expect(USERNS_SELFHEAL_SCRIPT.trimEnd().endsWith('exit 1')).toBe(true);
  });
});

describe('quadletUserNsHostHook — installQuadletUserNsHostHook', () => {
  it('installs the script and the ExecStartPre on a pre-#2808 box', async () => {
    const box = makeBox({});
    const res = await installQuadletUserNsHostHook(box.executor);

    expect(res.outcome).toBe('installed');
    expect(box.script).toBe(USERNS_SELFHEAL_SCRIPT);
    expect(hookLines(box.quadlet!)).toEqual([USERNS_SELFHEAL_EXEC_START_PRE]);
    // The quadlet is a generated unit's source — it is worthless without one.
    expect(box.argv.some(a => a.join(' ') === 'systemctl --user daemon-reload')).toBe(true);
    // /usr/local/bin is root-owned; the agent stages in /tmp and sudo-installs.
    expect(box.argv.some(a => a[0] === 'install' && a.includes(USERNS_SELFHEAL_PATH))).toBe(true);
  });

  it('is a no-op on the second run (idempotent against its own writes)', async () => {
    const box = makeBox({});
    await installQuadletUserNsHostHook(box.executor);
    const after = box.quadlet;
    box.argv.length = 0;

    const second = await installQuadletUserNsHostHook(box.executor);

    expect(second.outcome).toBe('already-current');
    expect(box.quadlet).toBe(after);
    expect(box.argv.filter(a => a[0] === 'install')).toEqual([]);
  });

  it('re-installs a script that drifted from the shipped text', async () => {
    const box = makeBox({ quadlet: renderQuadletSelfhealHook(QUADLET)!, script: '#!/bin/bash\nexit 0\n' });

    const res = await installQuadletUserNsHostHook(box.executor);

    expect(res.outcome).toBe('installed');
    expect(box.script).toBe(USERNS_SELFHEAL_SCRIPT);
  });

  it('does nothing on a host with no quadlet', async () => {
    const box = makeBox({ quadlet: null });

    const res = await installQuadletUserNsHostHook(box.executor);

    expect(res.outcome).toBe('no-quadlet');
    expect(box.argv).toEqual([]);
  });

  it('reports a host that refuses the write instead of throwing at the boot path', async () => {
    const box = makeBox({});
    box.executor.execSafe = async () => {
      throw new Error('sudo: a password is required');
    };

    const res = await installQuadletUserNsHostHook(box.executor);

    expect(res.outcome).toBe('failed');
    expect(res.detail).toContain('sudo');
  });
});
