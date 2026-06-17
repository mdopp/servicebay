import { describe, it, expect, vi } from 'vitest';
import { applyPlan, resolveTargetPath } from './plan';
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

// sourcePath is what scanMount's `find %p` emits: an ABSOLUTE path that already
// includes the mountpoint. Fixtures must reflect that so apply asserts the src is
// used verbatim (no `<mount>/<mount>/…` doubling, #1906).
function record(over: Partial<ImportRecord> = {}): ImportRecord {
  return { sourcePath: `${MOUNT}/song.mp3`, size: 100, mtimeMs: 0, ext: 'mp3', name: 'song.mp3', ...over };
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

describe('resolveTargetPath — owner prefix + merge/parallel (#1913)', () => {
  describe('owner prefix', () => {
    it('shared owner omits the owner segment', () => {
      expect(
        resolveTargetPath('Musik/song.mp3', 'music', { owner: 'shared', mode: 'merge', anchor: '' }),
      ).toBe('music/song.mp3');
    });

    it('a user owner prefixes data/<owner>/<category>/…', () => {
      expect(
        resolveTargetPath('Musik/song.mp3', 'music', { owner: 'cdopp', mode: 'merge', anchor: '' }),
      ).toBe('cdopp/music/song.mp3');
    });

    it('the same file under different owners lands in different areas', () => {
      const rel = 'inbox/report.pdf';
      expect(resolveTargetPath(rel, 'documents', { owner: 'shared', mode: 'merge', anchor: '' })).toBe(
        'documents/report.pdf',
      );
      expect(resolveTargetPath(rel, 'documents', { owner: 'mdopp', mode: 'merge', anchor: '' })).toBe(
        'mdopp/documents/report.pdf',
      );
    });
  });

  describe('mode: merge flattens into the category folder', () => {
    it('drops the source subtree, keeping only the basename', () => {
      expect(
        resolveTargetPath('Docs/2023/Q1/report.pdf', 'documents', { owner: 'shared', mode: 'merge', anchor: 'Docs' }),
      ).toBe('documents/report.pdf');
    });

    it('flattens identically regardless of how deep the source nests', () => {
      expect(
        resolveTargetPath('a/b/c/d/track.flac', 'music', { owner: 'cdopp', mode: 'merge', anchor: 'a' }),
      ).toBe('cdopp/music/track.flac');
    });
  });

  describe('mode: parallel preserves the source subtree below the anchor', () => {
    it('keeps the structure under the category folder (shared)', () => {
      expect(
        resolveTargetPath('Code/proj/src/main.ts', 'documents', { owner: 'shared', mode: 'parallel', anchor: 'Code' }),
      ).toBe('documents/proj/src/main.ts');
    });

    it('keeps the structure under data/<owner>/<category>/… (user owner)', () => {
      expect(
        resolveTargetPath('Code/proj/src/main.ts', 'documents', { owner: 'mdopp', mode: 'parallel', anchor: 'Code' }),
      ).toBe('mdopp/documents/proj/src/main.ts');
    });

    it('a file sitting exactly at the anchor keeps its basename (not dropped)', () => {
      expect(
        resolveTargetPath('Archive/readme.txt', 'documents', { owner: 'shared', mode: 'parallel', anchor: 'Archive/readme.txt' }),
      ).toBe('documents/readme.txt');
    });

    it('a root anchor preserves the whole relative path', () => {
      expect(
        resolveTargetPath('top/inner/file.bin', 'documents', { owner: 'shared', mode: 'parallel', anchor: '' }),
      ).toBe('documents/top/inner/file.bin');
    });
  });

  describe('junk + edge cases', () => {
    it('junk has no destination folder → null', () => {
      expect(resolveTargetPath('x/thumbs.db', 'junk', { owner: 'shared', mode: 'merge', anchor: '' })).toBeNull();
    });

    it('an empty / dot-only relative path → null', () => {
      expect(resolveTargetPath('', 'music', { owner: 'shared', mode: 'merge', anchor: '' })).toBeNull();
      expect(resolveTargetPath('./.', 'music', { owner: 'cdopp', mode: 'parallel', anchor: '' })).toBeNull();
    });

    it('normalises backslash separators and strips empty segments', () => {
      expect(
        resolveTargetPath('Code\\proj\\\\main.ts', 'documents', { owner: 'shared', mode: 'parallel', anchor: 'Code' }),
      ).toBe('documents/proj/main.ts');
    });
  });
});

describe('applyPlan — copy + chown', () => {
  it('rsyncs from the read-only mount into file-share/data and chowns to the share gid only', async () => {
    const { exec, calls, opts } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const res = await applyPlan(planOf(item()), baseOpts(exec, catalog, hashConst('a'.repeat(64))));

    const dest = resolveShareTarget('music/song.mp3');
    const rsync = calls.find(c => c[0] === 'rsync')!;
    expect(rsync).toEqual(['rsync', '-a', `${MOUNT}/song.mp3`, dest]);
    // The rsync src is the record's absolute sourcePath verbatim — NOT the
    // mountpoint re-prefixed onto it (that doubled `<mount>/<mount>/…`, #1906).
    expect(rsync[2]).toBe('/run/servicebay/disk-import/sda1/song.mp3');
    expect(rsync[2].startsWith(`${MOUNT}/${MOUNT}`)).toBe(false);
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
      item({ record: record({ sourcePath: `${MOUNT}/f${i}.mp3`, name: `f${i}.mp3` }), target: `music/f${i}.mp3` }),
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
    const conflict = item({ action: 'conflict', target: 'documents/report.pdf', record: record({ sourcePath: `${MOUNT}/report.pdf`, name: 'report.pdf', ext: 'pdf' }), category: 'documents' });

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

describe('applyPlan — photos place-in-folder (#1904 Decision A, no upload)', () => {
  it('rsyncs photos into the share like any category and never runs the immich CLI', async () => {
    const { exec, calls } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const photo = item({ category: 'photos', target: 'mdopp/photos/IMG_1.jpg', record: record({ sourcePath: `${MOUNT}/IMG_1.jpg`, name: 'img_1.jpg', ext: 'jpg' }) });

    const res = await applyPlan(planOf(photo), baseOpts(exec, catalog, hashConst('c'.repeat(64))));

    // No CLI upload anywhere — photos copy via rsync like every other category.
    expect(calls.some(c => c[0] === 'podman')).toBe(false);
    const rsync = calls.find(c => c[0] === 'rsync')!;
    expect(rsync).toContain(`${MOUNT}/IMG_1.jpg`);
    expect(res.items[0].outcome).toBe('copied');
    catalog.close();
  });

  it('reports the destination-area owners that received photos (for the library scan)', async () => {
    const { exec } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const priv = item({ category: 'photos', target: 'mdopp/photos/a.jpg', record: record({ sourcePath: `${MOUNT}/a.jpg`, name: 'a.jpg', ext: 'jpg' }) });
    const shared = item({ category: 'photos', target: 'photos/b.jpg', record: record({ sourcePath: `${MOUNT}/b.jpg`, name: 'b.jpg', ext: 'jpg' }) });
    const notPhoto = item({ category: 'music', target: 'music/x.mp3', record: record({ sourcePath: `${MOUNT}/x.mp3` }) });

    const res = await applyPlan(
      planOf(priv, shared, notPhoto),
      baseOpts(exec, catalog, hashConst('e'.repeat(64))),
    );

    expect([...res.photoOwners].sort()).toEqual(['mdopp', 'shared']);
    catalog.close();
  });

  it('emits no photo owners when nothing photo-shaped was written', async () => {
    const { exec } = mockExec();
    const catalog = new ImportCatalog(':memory:');
    const res = await applyPlan(planOf(item()), baseOpts(exec, catalog, hashConst('f'.repeat(64))));
    expect(res.photoOwners).toEqual([]);
    catalog.close();
  });
});

describe('applyPlan — resumability', () => {
  it('an interrupted apply re-run skips files already cataloged (no re-copy)', async () => {
    const catalog = new ImportCatalog(':memory:');
    const hashOf = hashConst('d'.repeat(64));
    const plan = planOf(
      item({ record: record({ sourcePath: `${MOUNT}/a.mp3`, name: 'a.mp3' }), target: 'music/a.mp3' }),
      item({ record: record({ sourcePath: `${MOUNT}/b.mp3`, name: 'b.mp3' }), target: 'music/b.mp3' }),
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
    expect(res.items.find(i => i.sourcePath === `${MOUNT}/a.mp3`)?.outcome).toBe('skipped-cataloged');
    expect(res.items.find(i => i.sourcePath === `${MOUNT}/b.mp3`)?.outcome).toBe('copied');
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
        item({ action: 'skip-dupe', record: record({ sourcePath: `${MOUNT}/dup.mp3`, name: 'dup.mp3' }), target: 'music/dup.mp3' }),
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
    const evil = item({ target: '../../../../etc/cron.d/payload', record: record({ sourcePath: `${MOUNT}/x`, name: 'x' }) });
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
