/**
 * #2788 — the boot migration that makes `servicebay.container` uid-agnostic.
 *
 * These tests model the HOST rather than asserting "some command was issued":
 * a fake box holds the quadlet text, un-quotes the `sh -c` write exactly the
 * way a POSIX shell would, and applies it. So a second run really does read
 * back what the first run wrote — which is what makes the idempotency
 * assertion mean something.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Executor } from './interfaces';
import {
  parseDeclaredUser,
  parseIdOutput,
  parseQuadletImage,
  renderQuadletUserNs,
  reconcileServicebayQuadletUserNs,
} from './quadletUserNs';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const IMAGE = 'ghcr.io/mdopp/servicebay:latest';

/** The shape Ignition writes (`fedora-coreos.bu`), trimmed to what matters here. */
const QUADLET = `[Unit]
Description=ServiceBay Rootless Management Interface
After=network-online.target

[Container]
Image=${IMAGE}
ContainerName=servicebay
AutoUpdate=registry
Network=host
Volume=/run/user/1000/podman/podman.sock:/run/podman/podman.sock
Volume=/mnt/data/servicebay:/app/data:Z

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
  writes: number;
  argv: string[][];
  executor: Executor;
}

/**
 * @param declaredUser what `podman image inspect --format '{{.Config.User}}'` prints
 * @param idOutput     what `podman run --entrypoint id <image>` prints (name → number)
 */
function makeBox(opts: {
  quadlet?: string | null;
  declaredUser?: string;
  inspectCode?: number;
  idOutput?: string;
}): FakeBox {
  const box: FakeBox = {
    quadlet: opts.quadlet === undefined ? QUADLET : opts.quadlet,
    writes: 0,
    argv: [],
    executor: null as unknown as Executor,
  };
  box.executor = {
    readFile: async () => {
      if (box.quadlet === null) throw new Error('File not found');
      return box.quadlet;
    },
    execSafe: async (argv: string[]) => {
      box.argv.push(argv);
      if (argv[1] === 'image' && argv[2] === 'inspect') {
        return { stdout: opts.declaredUser ?? '', stderr: '', code: opts.inspectCode ?? 0 };
      }
      if (argv[1] === 'run') {
        return { stdout: opts.idOutput ?? '', stderr: '', code: opts.idOutput ? 0 : 1 };
      }
      return { stdout: '', stderr: '', code: 0 };
    },
    exec: async (cmd: string) => {
      // The only shell call this module makes is the atomic quadlet write:
      // `sh -c <script> sh <content>`. Apply it to the fake box.
      const parts = shellSplit(cmd);
      expect(parts[0]).toBe('sh');
      box.quadlet = parts[4];
      box.writes++;
      return { stdout: '', stderr: '' };
    },
  } as unknown as Executor;
  return box;
}

const userNsLines = (q: string): string[] => q.split('\n').filter(l => l.startsWith('UserNS='));
const ranDaemonReload = (box: FakeBox): boolean => box.argv.some(a => a.join(' ').includes('daemon-reload'));

describe('quadletUserNs — parsing', () => {
  it('reads the image reference off the quadlet', () => {
    expect(parseQuadletImage(QUADLET)).toBe(IMAGE);
    expect(parseQuadletImage('[Container]\nContainerName=servicebay\n')).toBeNull();
  });

  it('treats empty / root / 0 as "runs as root"', () => {
    for (const spec of ['', '  ', 'root', 'root:root', '0', '0:0']) {
      expect(parseDeclaredUser(spec).kind).toBe('root');
    }
  });

  it('takes a numeric USER as-is and defaults the gid to the uid', () => {
    expect(parseDeclaredUser('1001:1002')).toEqual({ kind: 'numeric', user: { uid: 1001, gid: 1002 } });
    expect(parseDeclaredUser('1001')).toEqual({ kind: 'numeric', user: { uid: 1001, gid: 1001 } });
  });

  it('flags a NAMED user as needing resolution inside the image', () => {
    expect(parseDeclaredUser('nextjs').kind).toBe('named');
    expect(parseDeclaredUser('nextjs:nodejs').kind).toBe('named');
    expect(parseIdOutput('uid=1001(nextjs) gid=1001(nodejs) groups=1001(nodejs)')).toEqual({ uid: 1001, gid: 1001 });
    expect(parseIdOutput('no ids here')).toBeNull();
  });
});

describe('quadletUserNs — renderQuadletUserNs (pure)', () => {
  it('returns null (nothing to write) for a root image on a mapping-less quadlet', () => {
    expect(renderQuadletUserNs(QUADLET, null)).toBeNull();
  });

  it('inserts the mapping into [Container], right after ContainerName=', () => {
    const next = renderQuadletUserNs(QUADLET, { uid: 1001, gid: 1001 });
    expect(next).not.toBeNull();
    const lines = next!.split('\n');
    expect(lines[lines.indexOf('ContainerName=servicebay') + 1]).toBe('UserNS=keep-id:uid=1001,gid=1001');
    // Nothing outside [Container] moved.
    expect(next).toContain('ExecStartPre=-/bin/bash /usr/local/bin/servicebay-relabel-selfheal.sh');
  });

  it('returns null when the mapping on disk already matches (idempotent core)', () => {
    const once = renderQuadletUserNs(QUADLET, { uid: 1001, gid: 1001 })!;
    expect(renderQuadletUserNs(once, { uid: 1001, gid: 1001 })).toBeNull();
  });

  it('rewrites a stale mapping instead of adding a second one', () => {
    const stale = renderQuadletUserNs(QUADLET, { uid: 1001, gid: 1001 })!;
    const next = renderQuadletUserNs(stale, { uid: 1002, gid: 1002 })!;
    expect(userNsLines(next)).toEqual(['UserNS=keep-id:uid=1002,gid=1002']);
  });

  it('ignores a file with no [Container] section', () => {
    expect(renderQuadletUserNs('[Unit]\nDescription=x\n', { uid: 1001, gid: 1001 })).toBeNull();
  });
});

describe('quadletUserNs — reconcileServicebayQuadletUserNs', () => {
  // Acceptance (2): a no-op on today's still-root container.
  it('is a no-op while the image still runs as root — the quadlet is not touched', async () => {
    const box = makeBox({ declaredUser: '' });
    const res = await reconcileServicebayQuadletUserNs(box.executor);
    expect(res.outcome).toBe('root-noop');
    expect(box.writes).toBe(0);
    expect(box.quadlet).toBe(QUADLET);
    expect(ranDaemonReload(box)).toBe(false);
  });

  // Acceptance (3): the right mapping once the image declares a non-root user.
  it('writes keep-id for a NAMED non-root user, resolving the uid inside the image', async () => {
    const box = makeBox({ declaredUser: 'nextjs', idOutput: 'uid=1001(nextjs) gid=1001(nodejs) groups=1001(nodejs)' });
    const res = await reconcileServicebayQuadletUserNs(box.executor);
    expect(res.outcome).toBe('updated');
    expect(userNsLines(box.quadlet!)).toEqual(['UserNS=keep-id:uid=1001,gid=1001']);
    expect(ranDaemonReload(box)).toBe(true);
  });

  it('writes keep-id for a NUMERIC non-root user without running the image', async () => {
    const box = makeBox({ declaredUser: '1001:1002' });
    const res = await reconcileServicebayQuadletUserNs(box.executor);
    expect(res.outcome).toBe('updated');
    expect(userNsLines(box.quadlet!)).toEqual(['UserNS=keep-id:uid=1001,gid=1002']);
    expect(box.argv.some(a => a[1] === 'run')).toBe(false);
  });

  // Acceptance (1): safe to run every boot.
  it('is idempotent — a second run against the file the first wrote changes nothing', async () => {
    const box = makeBox({ declaredUser: '1001:1001' });
    await reconcileServicebayQuadletUserNs(box.executor);
    const afterFirst = box.quadlet;
    const second = await reconcileServicebayQuadletUserNs(box.executor);
    expect(second.outcome).toBe('already-current');
    expect(box.writes).toBe(1);
    expect(box.quadlet).toBe(afterFirst);
    expect(userNsLines(box.quadlet!)).toHaveLength(1);
  });

  it('is idempotent on a root box too — two boots, zero writes', async () => {
    const box = makeBox({ declaredUser: 'root' });
    await reconcileServicebayQuadletUserNs(box.executor);
    await reconcileServicebayQuadletUserNs(box.executor);
    expect(box.writes).toBe(0);
    expect(box.quadlet).toBe(QUADLET);
  });

  it('clears a stale mapping when the image goes back to root (rollback stays bootable)', async () => {
    const remapped = renderQuadletUserNs(QUADLET, { uid: 1001, gid: 1001 })!;
    const box = makeBox({ quadlet: remapped, declaredUser: 'root' });
    const res = await reconcileServicebayQuadletUserNs(box.executor);
    expect(res.outcome).toBe('root-cleared');
    expect(userNsLines(box.quadlet!)).toEqual([]);
    expect(box.quadlet).toBe(QUADLET);
    // …and the next boot has nothing left to do.
    const again = await reconcileServicebayQuadletUserNs(box.executor);
    expect(again.outcome).toBe('root-noop');
    expect(box.writes).toBe(1);
  });

  it('leaves the quadlet alone when the image cannot be inspected', async () => {
    const box = makeBox({ declaredUser: '', inspectCode: 125 });
    const res = await reconcileServicebayQuadletUserNs(box.executor);
    expect(res.outcome).toBe('unreadable-image');
    expect(box.writes).toBe(0);
  });

  it('leaves the quadlet alone when the named user cannot be resolved', async () => {
    const box = makeBox({ declaredUser: 'nextjs' }); // `podman run … id` fails
    const res = await reconcileServicebayQuadletUserNs(box.executor);
    expect(res.outcome).toBe('unreadable-image');
    expect(box.writes).toBe(0);
  });

  it('does nothing on a host with no servicebay quadlet', async () => {
    const box = makeBox({ quadlet: null });
    const res = await reconcileServicebayQuadletUserNs(box.executor);
    expect(res.outcome).toBe('no-quadlet');
    expect(box.writes).toBe(0);
    expect(box.argv).toHaveLength(0);
  });
});
