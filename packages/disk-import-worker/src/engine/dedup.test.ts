import { describe, it, expect, vi } from 'vitest';
import { buildPlan, targetFor, type HashResolver } from './dedup';
import { buildInventory, type ScannedFile } from './inventory';
import { ImportCatalog } from './catalog';
import type { ImportPlanItem, ImportRecord } from './types';

const sha = (c: string) => c.repeat(64);

/** Hash resolver driven by a path→hash fixture map. */
function hasherFrom(map: Record<string, string>): HashResolver {
  return (r: ImportRecord) => {
    const h = map[r.sourcePath];
    if (!h) throw new Error(`no fixture hash for ${r.sourcePath}`);
    return h;
  };
}

function plan(files: ScannedFile[], hashes: Record<string, string>, catalog?: ImportCatalog) {
  return buildPlan(buildInventory(files), hasherFrom(hashes), { catalog });
}

/**
 * Two-tier plan: explicit cheap `fingerprints` + full `hashes`, with both
 * resolvers spied so a test can assert WHICH files were actually read full
 * (#1995). A full-hash fixture may be omitted for files that should never be
 * fully read — the spy throws if such a file is full-hashed.
 */
function planFp(
  files: ScannedFile[],
  fingerprints: Record<string, string>,
  hashes: Record<string, string>,
  catalog?: ImportCatalog,
) {
  const fullHashed: string[] = [];
  const hashOf = vi.fn((r: ImportRecord) => {
    fullHashed.push(r.sourcePath);
    return hasherFrom(hashes)(r);
  });
  const fingerprintOf = vi.fn(hasherFrom(fingerprints));
  const result = buildPlan(buildInventory(files), hashOf, { catalog, fingerprintOf });
  return { result, fullHashed, hashOf, fingerprintOf };
}

function actionOf(items: ImportPlanItem[], sourcePath: string) {
  return items.find(i => i.record.sourcePath === sourcePath)?.action;
}

function itemOf(items: ImportPlanItem[], sourcePath: string) {
  return items.find(i => i.record.sourcePath === sourcePath);
}

describe('targetFor', () => {
  it('places files under their category folder with the base name', () => {
    const r = buildInventory([{ path: '/disk/sub/Photo.JPG', size: 1, mtimeMs: 0 }])[0];
    expect(targetFor(r, 'photos')).toBe('photos/photo.jpg');
  });
  it('junk has no target', () => {
    const r = buildInventory([{ path: '/disk/x.tmp', size: 1, mtimeMs: 0 }])[0];
    expect(targetFor(r, 'junk')).toBeNull();
  });
});

describe('buildPlan — junk + unique files', () => {
  it('skips junk and never hashes a unique-sized file', () => {
    const hashOf = vi.fn<HashResolver>(() => sha('a'));
    const records = buildInventory([
      { path: '/disk/a.jpg', size: 100, mtimeMs: 0 },
      { path: '/disk/b.flac', size: 200, mtimeMs: 0 },
      { path: '/disk/Thumbs.db', size: 50, mtimeMs: 0 },
    ]);
    const result = buildPlan(records, hashOf);
    expect(actionOf(result.items, '/disk/a.jpg')).toBe('copy');
    expect(actionOf(result.items, '/disk/b.flac')).toBe('copy');
    expect(actionOf(result.items, '/disk/Thumbs.db')).toBe('skip-junk');
    expect(result.conflicts).toHaveLength(0);
    // Unique sizes → no hashing.
    expect(hashOf).not.toHaveBeenCalled();
  });
});

describe('buildPlan — size→hash dedup within the tree', () => {
  it('same size + same hash + same target → second is skip-dupe', () => {
    // Same base name maps to the same target; identical bytes.
    const files: ScannedFile[] = [
      { path: '/diskA/song.mp3', size: 5000, mtimeMs: 0 },
      { path: '/diskB/song.mp3', size: 5000, mtimeMs: 0 },
    ];
    const result = plan(files, { '/diskA/song.mp3': sha('a'), '/diskB/song.mp3': sha('a') });
    // First in sourcePath order copies, the other is a dupe.
    expect(actionOf(result.items, '/diskA/song.mp3')).toBe('copy');
    expect(actionOf(result.items, '/diskB/song.mp3')).toBe('skip-dupe');
    expect(result.conflicts).toHaveLength(0);
  });

  it('same size but different hash AND different target → both copy, no conflict', () => {
    const files: ScannedFile[] = [
      { path: '/disk/one.mp3', size: 5000, mtimeMs: 0 },
      { path: '/disk/two.mp3', size: 5000, mtimeMs: 0 },
    ];
    const result = plan(files, { '/disk/one.mp3': sha('a'), '/disk/two.mp3': sha('b') });
    expect(actionOf(result.items, '/disk/one.mp3')).toBe('copy');
    expect(actionOf(result.items, '/disk/two.mp3')).toBe('copy');
    expect(result.conflicts).toHaveLength(0);
  });
});

describe('buildPlan — in-tree name clashes RENAME, never drop (#2006)', () => {
  it('two different files at the same target → both import, the later renamed', () => {
    const files: ScannedFile[] = [
      { path: '/diskA/report.pdf', size: 5000, mtimeMs: 0 },
      { path: '/diskB/report.pdf', size: 5000, mtimeMs: 0 },
    ];
    const result = plan(files, { '/diskA/report.pdf': sha('a'), '/diskB/report.pdf': sha('b') });
    // The first claims the natural name; the distinct second is imported renamed.
    expect(itemOf(result.items, '/diskA/report.pdf')).toMatchObject({
      action: 'copy',
      target: 'documents/report.pdf',
    });
    expect(itemOf(result.items, '/diskB/report.pdf')).toMatchObject({
      action: 'copy',
      target: 'documents/report (2).pdf',
      renamed: true,
    });
    // Nothing dropped — no unresolved conflicts.
    expect(result.conflicts).toHaveLength(0);
  });

  it('N distinct same-name files import as (2),(3)…; byte-identical ones still dedupe', () => {
    const files: ScannedFile[] = [
      { path: '/d1/IMG_0001.jpg', size: 5000, mtimeMs: 0 },
      { path: '/d2/IMG_0001.jpg', size: 5000, mtimeMs: 0 },
      { path: '/d3/IMG_0001.jpg', size: 5000, mtimeMs: 0 },
      { path: '/d4/IMG_0001.jpg', size: 5000, mtimeMs: 0 }, // byte-identical to /d1
    ];
    const result = plan(files, {
      '/d1/IMG_0001.jpg': sha('a'),
      '/d2/IMG_0001.jpg': sha('b'),
      '/d3/IMG_0001.jpg': sha('c'),
      '/d4/IMG_0001.jpg': sha('a'),
    });
    expect(itemOf(result.items, '/d1/IMG_0001.jpg')).toMatchObject({ action: 'copy', target: 'photos/img_0001.jpg' });
    expect(itemOf(result.items, '/d2/IMG_0001.jpg')).toMatchObject({ action: 'copy', target: 'photos/img_0001 (2).jpg', renamed: true });
    expect(itemOf(result.items, '/d3/IMG_0001.jpg')).toMatchObject({ action: 'copy', target: 'photos/img_0001 (3).jpg', renamed: true });
    // True duplicate of /d1 dedupes — only DISTINCT files get renamed.
    expect(actionOf(result.items, '/d4/IMG_0001.jpg')).toBe('skip-dupe');
    expect(result.conflicts).toHaveLength(0);
    // Renames are imports, not conflicts.
    expect(result.items.filter(i => i.action === 'conflict')).toHaveLength(0);
  });

  it('is deterministic — re-running yields the same names', () => {
    const files: ScannedFile[] = [
      { path: '/d1/report.pdf', size: 5000, mtimeMs: 0 },
      { path: '/d2/report.pdf', size: 5000, mtimeMs: 0 },
      { path: '/d3/report.pdf', size: 5000, mtimeMs: 0 },
    ];
    const hashes = { '/d1/report.pdf': sha('a'), '/d2/report.pdf': sha('b'), '/d3/report.pdf': sha('c') };
    const first = plan(files, hashes);
    const second = plan(files, hashes);
    expect(first.items.map(i => i.target)).toEqual(second.items.map(i => i.target));
    expect(first.items.map(i => i.target).sort()).toEqual([
      'documents/report (2).pdf',
      'documents/report (3).pdf',
      'documents/report.pdf',
    ]);
  });

  it('a renamed file does not collide with a real source file already named (2)', () => {
    const files: ScannedFile[] = [
      { path: '/d1/IMG_0001.jpg', size: 5000, mtimeMs: 0 },
      { path: '/d2/IMG_0001.jpg', size: 5000, mtimeMs: 0 }, // distinct → wants (2)
      { path: '/d3/IMG_0001 (2).jpg', size: 5000, mtimeMs: 0 }, // a REAL file already named (2)
    ];
    const result = plan(files, {
      '/d1/IMG_0001.jpg': sha('a'),
      '/d2/IMG_0001.jpg': sha('b'),
      '/d3/IMG_0001 (2).jpg': sha('c'),
    });
    const targets = result.items.map(i => i.target).sort();
    // All three distinct files land on distinct names; nothing dropped.
    expect(new Set(targets).size).toBe(3);
    expect(targets).toContain('photos/img_0001.jpg');
    expect(result.conflicts).toHaveLength(0);
    expect(result.items.filter(i => i.action === 'conflict')).toHaveLength(0);
  });
});

// Fingerprint-trust dedup (#1995): the cheap fingerprint IS the dedup identity —
// NO full-hash confirm on a first import — so a backup disk full of same-size
// duplicates is never read whole. Full hashing happens ONLY for a cataloged
// target (delta run). Source is read-only/copy-only, so a (near-impossible)
// fingerprint false-match means one file not copied, never data loss.
describe('buildPlan — fingerprint-trust dedup (#1995)', () => {
  it('same size + DIFFERENT fingerprint → distinct, so renamed WITHOUT reading either file whole', () => {
    const files: ScannedFile[] = [
      { path: '/diskA/report.pdf', size: 5000, mtimeMs: 0 },
      { path: '/diskB/report.pdf', size: 5000, mtimeMs: 0 },
    ];
    const { result, fullHashed } = planFp(
      files,
      { '/diskA/report.pdf': 'fpA', '/diskB/report.pdf': 'fpB' },
      {}, // no full-hash fixtures: full-hashing either file would throw
    );
    // Distinct fingerprints ⇒ distinct files ⇒ the later one is imported renamed (#2006).
    expect(itemOf(result.items, '/diskB/report.pdf')).toMatchObject({
      action: 'copy',
      target: 'documents/report (2).pdf',
      renamed: true,
    });
    expect(fullHashed).toEqual([]); // distinct fingerprints settle it cheaply
  });

  it('same size + SAME fingerprint → skip-dupe WITHOUT a full read (first import)', () => {
    const files: ScannedFile[] = [
      { path: '/diskA/report.pdf', size: 5000, mtimeMs: 0 },
      { path: '/diskB/report.pdf', size: 5000, mtimeMs: 0 },
    ];
    const { result, fullHashed } = planFp(
      files,
      { '/diskA/report.pdf': 'fp', '/diskB/report.pdf': 'fp' },
      {}, // a full read would throw — proves we never do one
    );
    expect(actionOf(result.items, '/diskA/report.pdf')).toBe('copy');
    expect(actionOf(result.items, '/diskB/report.pdf')).toBe('skip-dupe');
    expect(fullHashed).toEqual([]);
  });

  it('a cataloged target IS full-hashed (delta run compares against stored sha256)', () => {
    const catalog = new ImportCatalog(':memory:');
    catalog.upsert({ sha256: sha('a'), target: 'documents/report.pdf', sourcePath: '/old/report.pdf', size: 5000, importedAtMs: 0 });
    const files: ScannedFile[] = [{ path: '/diskA/report.pdf', size: 5000, mtimeMs: 0 }];
    const { result, fullHashed } = planFp(
      files,
      { '/diskA/report.pdf': 'fp' },
      { '/diskA/report.pdf': sha('a') },
      catalog,
    );
    expect(actionOf(result.items, '/diskA/report.pdf')).toBe('skip-dupe');
    expect(fullHashed).toEqual(['/diskA/report.pdf']);
  });

  it('size-unique file is NEVER fingerprinted or hashed', () => {
    const files: ScannedFile[] = [
      { path: '/disk/a.jpg', size: 111, mtimeMs: 0 },
      { path: '/disk/b.mp3', size: 222, mtimeMs: 0 },
    ];
    const { result, fullHashed, fingerprintOf } = planFp(files, {}, {});
    expect(actionOf(result.items, '/disk/a.jpg')).toBe('copy');
    expect(actionOf(result.items, '/disk/b.mp3')).toBe('copy');
    expect(fullHashed).toEqual([]);
    expect(fingerprintOf).not.toHaveBeenCalled();
  });
});

describe('buildPlan — catalog delta (cross-run)', () => {
  it('re-running the same input yields all skip-dupe against the catalog', () => {
    const cat = new ImportCatalog(':memory:');
    const files: ScannedFile[] = [
      { path: '/disk/a.jpg', size: 100, mtimeMs: 0 },
      { path: '/disk/song.flac', size: 200, mtimeMs: 0 },
    ];
    const hashes = { '/disk/a.jpg': sha('a'), '/disk/song.flac': sha('b') };

    // First run: everything copies; record the results into the catalog.
    const first = plan(files, hashes, cat);
    for (const item of first.items) {
      expect(item.action).toBe('copy');
      cat.upsert({
        sha256: hashes[item.record.sourcePath as keyof typeof hashes],
        target: item.target!,
        sourcePath: item.record.sourcePath,
        size: item.record.size,
        importedAtMs: 0,
      });
    }

    // Second run over the same disk: all skip-dupe (delta run).
    const second = plan(files, hashes, cat);
    expect(second.items.every(i => i.action === 'skip-dupe')).toBe(true);
    expect(second.conflicts).toHaveLength(0);
    cat.close();
  });

  it('different content for an already-cataloged target → conflict', () => {
    const cat = new ImportCatalog(':memory:');
    cat.upsert({
      sha256: sha('a'),
      target: 'documents/report.pdf',
      sourcePath: '/old/report.pdf',
      size: 5000,
      importedAtMs: 0,
    });
    const result = plan(
      [{ path: '/disk/report.pdf', size: 5000, mtimeMs: 0 }],
      { '/disk/report.pdf': sha('b') },
      cat,
    );
    expect(actionOf(result.items, '/disk/report.pdf')).toBe('conflict');
    expect(result.conflicts[0]).toMatchObject({
      target: 'documents/report.pdf',
      existing: { sourcePath: '/old/report.pdf', sha256: sha('a') },
      incoming: { sourcePath: '/disk/report.pdf', sha256: sha('b') },
    });
    cat.close();
  });
});

describe('buildPlan — destination-area dedup scope (#1912)', () => {
  // Two sources with the SAME base name + identical bytes. In one area they
  // collapse (shared merges); in distinct areas they both copy (private dedups
  // within itself only).
  const files: ScannedFile[] = [
    { path: '/diskA/song.mp3', size: 5000, mtimeMs: 0 },
    { path: '/diskB/song.mp3', size: 5000, mtimeMs: 0 },
  ];
  const hashes = { '/diskA/song.mp3': sha('a'), '/diskB/song.mp3': sha('a') };

  it('shared area (default): identical bytes at the same target collapse to skip-dupe', () => {
    const result = buildPlan(buildInventory(files), hasherFrom(hashes));
    expect(actionOf(result.items, '/diskA/song.mp3')).toBe('copy');
    expect(actionOf(result.items, '/diskB/song.mp3')).toBe('skip-dupe');
  });

  it('distinct private areas: same target in different areas both copy (no cross-area merge)', () => {
    const areaOf = (r: ImportRecord) =>
      r.sourcePath.startsWith('/diskA/') ? 'mdopp' : 'cdopp';
    const result = buildPlan(buildInventory(files), hasherFrom(hashes), { areaOf });
    // Each private area dedups only within itself → no merge across users.
    expect(actionOf(result.items, '/diskA/song.mp3')).toBe('copy');
    expect(actionOf(result.items, '/diskB/song.mp3')).toBe('copy');
    expect(result.conflicts).toHaveLength(0);
  });

  it('same content already cataloged in shared does NOT dupe-skip a private area', () => {
    const cat = new ImportCatalog(':memory:');
    cat.upsert({
      sha256: sha('a'),
      area: 'shared',
      target: 'music/song.mp3',
      sourcePath: '/old/song.mp3',
      size: 5000,
      importedAtMs: 0,
    });
    // Importing the same bytes/target but owned by a user → fresh copy in the
    // user area (shared catalog hit must not leak across the area boundary).
    const result = buildPlan(
      buildInventory([{ path: '/disk/song.mp3', size: 5000, mtimeMs: 0 }]),
      hasherFrom({ '/disk/song.mp3': sha('a') }),
      { catalog: cat, areaOf: () => 'mdopp' },
    );
    expect(actionOf(result.items, '/disk/song.mp3')).toBe('copy');
    cat.close();
  });
});

describe('buildPlan — determinism', () => {
  it('produces a stable, source-path-ordered plan', () => {
    const files: ScannedFile[] = [
      { path: '/disk/z.jpg', size: 1, mtimeMs: 0 },
      { path: '/disk/a.flac', size: 2, mtimeMs: 0 },
      { path: '/disk/m.pdf', size: 3, mtimeMs: 0 },
    ];
    const hashes = { '/disk/z.jpg': sha('1'), '/disk/a.flac': sha('2'), '/disk/m.pdf': sha('3') };
    const a = plan(files, hashes);
    const b = plan(files.slice().reverse(), hashes);
    expect(a.items.map(i => i.record.sourcePath)).toEqual(b.items.map(i => i.record.sourcePath));
    expect(a.items.map(i => i.target)).toEqual(['music/a.flac', 'documents/m.pdf', 'photos/z.jpg']);
  });
});

describe('buildPlan — routing tree (#1915)', () => {
  // The routing option resolves owner-aware targets + the folder's forced
  // disposition, mirroring what the service threads through from the review tree.
  function routingFor(rules: Record<string, import('./types').Rule>, defaultOwner = 'shared') {
    return {
      relPathOf: (r: ImportRecord) => r.sourcePath.replace(/^\/disk\//, ''),
      explicit: new Map(Object.entries(rules)),
      rootDefault: defaultOwner === 'shared' ? {} : { owner: defaultOwner },
    };
  }

  it('an owner rule prefixes the target with the owner segment', () => {
    const files: ScannedFile[] = [{ path: '/disk/mdopp/IMG.jpg', size: 1, mtimeMs: 0 }];
    const result = buildPlan(buildInventory(files), hasherFrom({ '/disk/mdopp/IMG.jpg': sha('a') }), {
      routing: routingFor({ mdopp: { owner: 'mdopp' } }),
    });
    expect(result.items[0].target).toBe('mdopp/photos/IMG.jpg');
  });

  it('shared (no owner) keeps the bare category target', () => {
    const files: ScannedFile[] = [{ path: '/disk/IMG.jpg', size: 1, mtimeMs: 0 }];
    const result = buildPlan(buildInventory(files), hasherFrom({ '/disk/IMG.jpg': sha('a') }), {
      routing: routingFor({}),
    });
    expect(result.items[0].target).toBe('photos/IMG.jpg');
  });

  it('a `skip` disposition routes the folder to junk (not imported)', () => {
    const files: ScannedFile[] = [{ path: '/disk/junkdir/x.pdf', size: 1, mtimeMs: 0 }];
    const result = buildPlan(buildInventory(files), hasherFrom({ '/disk/junkdir/x.pdf': sha('a') }), {
      routing: routingFor({ junkdir: { disposition: 'skip' } }),
    });
    expect(result.items[0].action).toBe('skip-junk');
    expect(result.items[0].target).toBeNull();
  });

  it('a forced disposition overrides the content classifier', () => {
    // A .pdf forced to movies_jellyfin lands in movies/ (disposition wins).
    const files: ScannedFile[] = [{ path: '/disk/Filme/clip.pdf', size: 1, mtimeMs: 0 }];
    const result = buildPlan(buildInventory(files), hasherFrom({ '/disk/Filme/clip.pdf': sha('a') }), {
      routing: routingFor({ Filme: { disposition: 'movies_jellyfin' } }),
    });
    expect(result.items[0].category).toBe('movies');
    expect(result.items[0].target).toBe('movies/clip.pdf');
  });

  it('two owners with the same bytes+target are NOT duplicates (private areas dedup separately)', () => {
    const files: ScannedFile[] = [
      { path: '/disk/mdopp/IMG.jpg', size: 10, mtimeMs: 0 },
      { path: '/disk/cdopp/IMG.jpg', size: 10, mtimeMs: 0 },
    ];
    const hashes = { '/disk/mdopp/IMG.jpg': sha('a'), '/disk/cdopp/IMG.jpg': sha('a') };
    const result = buildPlan(buildInventory(files), hasherFrom(hashes), {
      routing: routingFor({ mdopp: { owner: 'mdopp' }, cdopp: { owner: 'cdopp' } }),
    });
    // Different owner areas → both copy (neither is a dupe of the other).
    expect(result.items.every(i => i.action === 'copy')).toBe(true);
    expect(result.items.map(i => i.target).sort()).toEqual(['cdopp/photos/IMG.jpg', 'mdopp/photos/IMG.jpg']);
  });
});

describe('buildPlan — per-category layout + identity (#2006 redesign)', () => {
  // A routing resolution rooted at the disk (strips the `/disk/` prefix), default
  // shared owner — the same shape the worker threads through for the initial plan.
  const routingFor = (rules: Record<string, import('./types').Rule> = {}) => ({
    relPathOf: (r: ImportRecord) => r.sourcePath.replace(/^\/disk\//, ''),
    explicit: new Map(Object.entries(rules)),
    rootDefault: {},
  });

  it('documents PRESERVE source folders; identical bytes across folders collapse by content', () => {
    const files: ScannedFile[] = [
      { path: '/disk/backup_2025/docs/note.txt', size: 10, mtimeMs: 0 },
      { path: '/disk/backup_2026/docs/note.txt', size: 10, mtimeMs: 0 }, // identical bytes
      { path: '/disk/backup_2023/notes/note.txt', size: 10, mtimeMs: 0 }, // DIFFERENT bytes
    ];
    const result = buildPlan(buildInventory(files), hasherFrom({
      '/disk/backup_2025/docs/note.txt': sha('a'),
      '/disk/backup_2026/docs/note.txt': sha('a'),
      '/disk/backup_2023/notes/note.txt': sha('b'),
    }), { routing: routingFor() });
    // 2025 copies at its preserved path; 2026 (same bytes) dedupes; notes/ (different
    // bytes, different folder) is kept distinct — exactly the operator's model.
    expect(itemOf(result.items, '/disk/backup_2025/docs/note.txt')).toMatchObject({
      action: 'copy', target: 'documents/backup_2025/docs/note.txt',
    });
    expect(actionOf(result.items, '/disk/backup_2026/docs/note.txt')).toBe('skip-dupe');
    expect(itemOf(result.items, '/disk/backup_2023/notes/note.txt')).toMatchObject({
      action: 'copy', target: 'documents/backup_2023/notes/note.txt',
    });
    expect(result.conflicts).toHaveLength(0);
  });

  it('photos dedupe by CONTENT only — same name, different bytes → BOTH kept (preserved paths)', () => {
    const files: ScannedFile[] = [
      { path: '/disk/2019/IMG_0001.jpg', size: 10, mtimeMs: 0 },
      { path: '/disk/2021/IMG_0001.jpg', size: 10, mtimeMs: 0 }, // same name, different photo
    ];
    const result = buildPlan(buildInventory(files), hasherFrom({
      '/disk/2019/IMG_0001.jpg': sha('a'),
      '/disk/2021/IMG_0001.jpg': sha('b'),
    }), { routing: routingFor() });
    expect(result.items.every(i => i.action === 'copy')).toBe(true);
    expect(result.items.map(i => i.target).sort()).toEqual([
      'photos/2019/IMG_0001.jpg', 'photos/2021/IMG_0001.jpg',
    ]);
    expect(result.items.some(i => i.renamed)).toBe(false); // distinct paths, no rename
  });

  it('music dedupes by NAME+SIZE, flattened, WITHOUT hashing', () => {
    const hashOf = vi.fn<HashResolver>(() => { throw new Error('music must not be hashed'); });
    // Stable order is by sourcePath: backup < mix < rock.
    const files: ScannedFile[] = [
      { path: '/disk/backup/01.mp3', size: 100, mtimeMs: 0 }, // first claimant of music/01.mp3
      { path: '/disk/mix/01.mp3', size: 200, mtimeMs: 0 },    // same name, different size → different track
      { path: '/disk/rock/01.mp3', size: 100, mtimeMs: 0 },   // same name+size as backup → same track
    ];
    const result = buildPlan(buildInventory(files), hashOf, {
      routing: routingFor(), fingerprintOf: hashOf,
    });
    expect(hashOf).not.toHaveBeenCalled(); // name+size identity → zero reads
    expect(itemOf(result.items, '/disk/backup/01.mp3')).toMatchObject({ action: 'copy', target: 'music/01.mp3' });
    expect(actionOf(result.items, '/disk/rock/01.mp3')).toBe('skip-dupe'); // same name+size as backup
    // Different size = different track → kept, renamed off the flat clash.
    expect(itemOf(result.items, '/disk/mix/01.mp3')).toMatchObject({
      action: 'copy', target: 'music/01 (2).mp3', renamed: true,
    });
    expect(result.conflicts).toHaveLength(0);
  });
});
