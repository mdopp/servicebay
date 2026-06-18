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

describe('buildPlan — conflicts (same target, different content)', () => {
  it('flags two different files competing for the same target path', () => {
    const files: ScannedFile[] = [
      { path: '/diskA/report.pdf', size: 5000, mtimeMs: 0 },
      { path: '/diskB/report.pdf', size: 5000, mtimeMs: 0 },
    ];
    const result = plan(files, { '/diskA/report.pdf': sha('a'), '/diskB/report.pdf': sha('b') });
    expect(actionOf(result.items, '/diskA/report.pdf')).toBe('copy');
    expect(actionOf(result.items, '/diskB/report.pdf')).toBe('conflict');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      target: 'documents/report.pdf',
      existing: { sourcePath: '/diskA/report.pdf' },
      incoming: { sourcePath: '/diskB/report.pdf' },
    });
  });
});

// Two-tier dedup (#1995): cheap fingerprint first, full hash only on a
// fingerprint collision — so a backup disk full of same-size files is not read
// whole, and dedup stays exact (a fingerprint match is CONFIRMED by full hash).
describe('buildPlan — two-tier fingerprint dedup (#1995)', () => {
  it('same size + DIFFERENT fingerprint → conflict WITHOUT reading either file whole', () => {
    const files: ScannedFile[] = [
      { path: '/diskA/report.pdf', size: 5000, mtimeMs: 0 },
      { path: '/diskB/report.pdf', size: 5000, mtimeMs: 0 },
    ];
    const { result, fullHashed } = planFp(
      files,
      { '/diskA/report.pdf': 'fpA', '/diskB/report.pdf': 'fpB' },
      {}, // no full-hash fixtures: full-hashing either file would throw
    );
    expect(actionOf(result.items, '/diskB/report.pdf')).toBe('conflict');
    expect(fullHashed).toEqual([]); // distinct fingerprints settle it cheaply
  });

  it('same size + SAME fingerprint → full-hash CONFIRMS: identical content is skip-dupe', () => {
    const files: ScannedFile[] = [
      { path: '/diskA/report.pdf', size: 5000, mtimeMs: 0 },
      { path: '/diskB/report.pdf', size: 5000, mtimeMs: 0 },
    ];
    const { result, fullHashed } = planFp(
      files,
      { '/diskA/report.pdf': 'fp', '/diskB/report.pdf': 'fp' },
      { '/diskA/report.pdf': sha('a'), '/diskB/report.pdf': sha('a') },
    );
    expect(actionOf(result.items, '/diskA/report.pdf')).toBe('copy');
    expect(actionOf(result.items, '/diskB/report.pdf')).toBe('skip-dupe');
    expect(fullHashed.sort()).toEqual(['/diskA/report.pdf', '/diskB/report.pdf']);
  });

  it('same size + SAME fingerprint but DIFFERENT full hash → confirmed conflict with full shas', () => {
    const files: ScannedFile[] = [
      { path: '/diskA/report.pdf', size: 5000, mtimeMs: 0 },
      { path: '/diskB/report.pdf', size: 5000, mtimeMs: 0 },
    ];
    const { result } = planFp(
      files,
      { '/diskA/report.pdf': 'fp', '/diskB/report.pdf': 'fp' },
      { '/diskA/report.pdf': sha('a'), '/diskB/report.pdf': sha('b') },
    );
    expect(result.conflicts[0]).toMatchObject({
      existing: { sourcePath: '/diskA/report.pdf', sha256: sha('a') },
      incoming: { sourcePath: '/diskB/report.pdf', sha256: sha('b') },
    });
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
