import { describe, it, expect, vi } from 'vitest';
import { applyPlan } from './plan';
import { ImportCatalog } from './catalog';
import { resolveShareTarget, resolveSupersededPath, type SafeExec, type SafeExecResult } from './hostExec';
import type { HashResolver } from './dedup';
import type { ImportPlan, ImportPlanItem, ImportRecord } from './types';

const ok: SafeExecResult = { stdout: '', stderr: '', code: 0 };
const MOUNT = '/run/servicebay/disk-import/sda1';
const GID = 7777;
const FIXED_NOW = Date.UTC(2026, 5, 5); // 2026-06-05

function mockExec(
  byBinary: Record<string, SafeExecResult | ((argv: string[]) => SafeExecResult)> = {},
): { exec: SafeExec; calls: string[][]; opts: ({ timeoutMs?: number; sudo?: boolean } | undefined)[] } {
  const calls: string[][] = [];
  const opts: ({ timeoutMs?: number; sudo?: boolean } | undefined)[] = [];
  // Mirrors agent.sendCommand: an error reply is a THROW, not a returned {error}.
  const exec: SafeExec = vi.fn(async (argv: string[], options?) => {
    calls.push(argv);
    opts.push(options);
    const handler = byBinary[argv[0]];
    if (handler === undefined) return ok;
    return typeof handler === 'function' ? handler(argv) : handler;
  });
  return { exec, calls, opts };
}

/** sudo flag passed alongside the first call whose argv[0] === binary. */
function sudoFor(calls: string[][], opts: ({ sudo?: boolean } | undefined)[], binary: string): boolean | undefined {
  const i = calls.findIndex(c => c[0] === binary);
  return i === -1 ? undefined : opts[i]?.sudo;
}

function record(over: Partial<ImportRecord> = {}): ImportRecord {
  return { sourcePath: '/song.mp3', size: 100, mtimeMs: 0, ext: 'mp3', name: 'song.mp3', ...over };
}

function item(over: Partial<ImportPlanItem> = {}): ImportPlanItem {
  return { record: record(), category: 'music', target: 'music/song.mp3', action: 'copy', ...over };
}

function planOf(...items: ImportPlanItem[]): ImportPlan {
  return { items, conflicts: [] };
}

const hashConst = (h: string): HashResolver => () => h;

function baseOpts(exec: SafeExec, catalog: ImportCatalog, hashOf: HashResolver) {
  return { exec, mountpoint: MOUNT, catalog, shareGid: GID, hashOf, now: () => FIXED_NOW };
}

describe('applyPlan — copy + chown', () => {
  it('rsyncs from the read-only mount into file-share/data and chowns to the share gid only', async () => {
    const { exec, calls, opts } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const res = await applyPlan(planOf(item()), baseOpts(exec, catalog, hashConst('a'.repeat(64))));

    const dest = resolveShareTarget('music/song.mp3');
    const rsync = calls.find(c => c[0] === 'rsync')!;
    expect(rsync).toEqual(['rsync', '-a', `${MOUNT}/song.mp3`, dest]);
    // Source is under the read-only mount; dest is under the share root.
    expect(rsync[2].startsWith(MOUNT + '/')).toBe(true);
    expect(rsync[3].startsWith('/mnt/data/stacks/file-share/data/')).toBe(true);

    const chown = calls.find(c => c[0] === 'chown')!;
    expect(chown).toEqual(['chown', `:${GID}`, dest]); // group only, never uid, never -R
    expect(chown).not.toContain('-R');
    expect(chown[1]).toMatch(/^:\d+$/);

    // The /mnt/data writes all run privileged (#1713): mkdir, rsync, chown.
    expect(sudoFor(calls, opts, 'mkdir')).toBe(true);
    expect(sudoFor(calls, opts, 'rsync')).toBe(true);
    expect(sudoFor(calls, opts, 'chown')).toBe(true);

    expect(res.applied).toBe(1);
    expect(res.items[0].outcome).toBe('copied');
    expect(catalog.has('a'.repeat(64), 'music/song.mp3')).toBe(true);
    catalog.close();
  });

  it('rejects a non-integer / negative share gid before any host I/O', async () => {
    const { exec, calls } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    await expect(
      applyPlan(planOf(item()), { ...baseOpts(exec, catalog, hashConst('a'.repeat(64))), shareGid: -1 }),
    ).rejects.toThrow(/shareGid/);
    expect(calls).toHaveLength(0);
    catalog.close();
  });
});

describe('applyPlan — batched mkdir/chown (#1898)', () => {
  it('copies an N-file plan with ONE mkdir + ONE chown (not one per file)', async () => {
    const { exec, calls } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const n = 8;
    const items = Array.from({ length: n }, (_, i) =>
      item({ record: record({ sourcePath: `/f${i}.mp3`, name: `f${i}.mp3` }), target: `music/f${i}.mp3` }),
    );
    const res = await applyPlan(planOf(...items), baseOpts(exec, catalog, hashConst('a'.repeat(64))));

    const mkdirs = calls.filter(c => c[0] === 'mkdir');
    const rsyncs = calls.filter(c => c[0] === 'rsync');
    const chowns = calls.filter(c => c[0] === 'chown');
    // mkdir + chown are batched: one each for the whole batch. rsync stays
    // per-file (the byte copy + resume granularity).
    expect(mkdirs).toHaveLength(1);
    expect(chowns).toHaveLength(1);
    expect(rsyncs).toHaveLength(n);
    // The single chown carries every dest, group-only, never -R.
    expect(chowns[0][0]).toBe('chown');
    expect(chowns[0][1]).toBe(`:${GID}`);
    expect(chowns[0]).not.toContain('-R');
    expect(chowns[0].slice(2)).toEqual(items.map(i => resolveShareTarget(i.target!)));
    // The single mkdir -p carries the (deduped) dest dir.
    expect(mkdirs[0]).toEqual(['mkdir', '-p', '/mnt/data/stacks/file-share/data/music']);
    expect(res.applied).toBe(n);
    expect(res.items.every(i => i.outcome === 'copied')).toBe(true);
    expect(items.every(i => catalog.has('a'.repeat(64), i.target!))).toBe(true);
    catalog.close();
  });
});

describe('applyPlan — conflict routes to _superseded', () => {
  it('moves the existing target into _superseded/<date>/ before copying the newer file', async () => {
    const { exec, calls, opts } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const conflict = item({ action: 'conflict', target: 'documents/report.pdf', record: record({ sourcePath: '/report.pdf', name: 'report.pdf', ext: 'pdf' }), category: 'documents' });

    const res = await applyPlan(planOf(conflict), baseOpts(exec, catalog, hashConst('b'.repeat(64))));

    const mv = calls.find(c => c[0] === 'mv')!;
    const parked = resolveSupersededPath('2026-06-05/documents/report.pdf');
    expect(mv).toEqual(['mv', resolveShareTarget('documents/report.pdf'), parked]);
    // The _superseded move into /mnt/data is privileged (#1713).
    expect(sudoFor(calls, opts, 'mv')).toBe(true);
    // Then the newer file is copied in.
    expect(calls.some(c => c[0] === 'rsync')).toBe(true);
    expect(res.items[0].outcome).toBe('superseded');
    catalog.close();
  });
});

describe('applyPlan — photos go to Immich, not file-share', () => {
  it('runs the immich CLI and never rsyncs photos into the share', async () => {
    const { exec, calls, opts } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const photo = item({ category: 'photos', target: 'photos/IMG_1.jpg', record: record({ sourcePath: '/IMG_1.jpg', name: 'img_1.jpg', ext: 'jpg' }) });

    const res = await applyPlan(planOf(photo), {
      ...baseOpts(exec, catalog, hashConst('c'.repeat(64))),
      immich: { serverUrl: 'http://immich:2283', apiKey: 'secret-key' },
    });

    const podman = calls.find(c => c[0] === 'podman')!;
    expect(podman).toContain('upload');
    // Immich upload runs through ROOTLESS podman as `core` — must NOT escalate.
    expect(sudoFor(calls, opts, 'podman')).not.toBe(true);
    expect(podman.join(' ')).toContain('IMMICH_INSTANCE_URL=http://immich:2283');
    // API key passed via env, never bare on argv positionally beyond the -e pair.
    expect(podman).toContain('IMMICH_API_KEY=secret-key');
    // No file-share writes for a photo.
    expect(calls.some(c => c[0] === 'rsync')).toBe(false);
    expect(res.items[0].outcome).toBe('photo-uploaded');
    catalog.close();
  });
});

describe('applyPlan — resumability', () => {
  it('an interrupted apply re-run skips files already cataloged (no re-copy)', async () => {
    const catalog = new ImportCatalog(':memory:');
    const hashOf = hashConst('d'.repeat(64));
    const plan = planOf(
      item({ record: record({ sourcePath: '/a.mp3', name: 'a.mp3' }), target: 'music/a.mp3' }),
      item({ record: record({ sourcePath: '/b.mp3', name: 'b.mp3' }), target: 'music/b.mp3' }),
    );

    // First pass: rsync of b.mp3 "fails" (interruption) after a.mp3 is done.
    let failBNext = true;
    const exec1 = mockExec({
      rsync: (argv) => {
        if (failBNext && argv[2].endsWith('/b.mp3')) return { stdout: '', stderr: 'interrupted', code: 1 };
        return ok;
      },
    });
    await expect(applyPlan(plan, baseOpts(exec1.exec, catalog, hashOf))).rejects.toThrow(/rsync/);
    expect(catalog.has('d'.repeat(64), 'music/a.mp3')).toBe(true);
    expect(catalog.has('d'.repeat(64), 'music/b.mp3')).toBe(false);

    // Second pass: everything succeeds. a.mp3 must be skipped (cataloged),
    // only b.mp3 is rsynced.
    failBNext = false;
    const exec2 = mockExec();
    const res = await applyPlan(plan, baseOpts(exec2.exec, catalog, hashOf));

    const rsyncs = exec2.calls.filter(c => c[0] === 'rsync').map(c => c[2]);
    expect(rsyncs).toEqual([`${MOUNT}/b.mp3`]); // a.mp3 NOT re-copied
    expect(res.items.find(i => i.sourcePath === '/a.mp3')?.outcome).toBe('skipped-cataloged');
    expect(res.items.find(i => i.sourcePath === '/b.mp3')?.outcome).toBe('copied');
    expect(catalog.has('d'.repeat(64), 'music/b.mp3')).toBe(true);
    catalog.close();
  });
});

describe('applyPlan — dry run + skips', () => {
  it('dry-run computes outcomes without touching the host', async () => {
    const { exec, calls } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const res = await applyPlan(planOf(item()), { ...baseOpts(exec, catalog, hashConst('e'.repeat(64))), dryRun: true });
    expect(calls).toHaveLength(0);
    expect(res.applied).toBe(0);
    expect(res.items[0].outcome).toBe('dry-run');
    catalog.close();
  });

  it('skip-junk / skip-dupe items are not copied', async () => {
    const { exec, calls } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const res = await applyPlan(
      planOf(
        item({ action: 'skip-junk', target: null }),
        item({ action: 'skip-dupe', record: record({ sourcePath: '/dup.mp3', name: 'dup.mp3' }), target: 'music/dup.mp3' }),
      ),
      baseOpts(exec, catalog, hashConst('f'.repeat(64))),
    );
    expect(calls).toHaveLength(0);
    expect(res.items.map(i => i.outcome)).toEqual(['skipped-junk', 'skipped-dupe']);
    catalog.close();
  });
});

describe('applyPlan — path traversal is refused', () => {
  it('a malicious category/filename target cannot escape the share root', async () => {
    const { exec, calls } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const evil = item({ target: '../../../../etc/cron.d/payload', record: record({ sourcePath: '/x', name: 'x' }) });
    await expect(applyPlan(planOf(evil), baseOpts(exec, catalog, hashConst('0'.repeat(64))))).rejects.toThrow(/traversal/);
    // Nothing was written to the host.
    expect(calls.some(c => c[0] === 'rsync' || c[0] === 'mv' || c[0] === 'chown')).toBe(false);
    catalog.close();
  });

  it('resolveShareTarget / resolveSupersededPath reject absolute + traversal inputs', () => {
    expect(() => resolveShareTarget('/etc/passwd')).toThrow(/absolute/);
    expect(() => resolveShareTarget('photos/../../escape')).toThrow(/traversal/);
    // A clean target resolves under the share root.
    expect(resolveShareTarget('music/ok.mp3')).toBe('/mnt/data/stacks/file-share/data/music/ok.mp3');
    expect(resolveSupersededPath('2026-06-05/music/ok.mp3')).toBe(
      '/mnt/data/stacks/file-share/data/_superseded/2026-06-05/music/ok.mp3',
    );
  });
});
