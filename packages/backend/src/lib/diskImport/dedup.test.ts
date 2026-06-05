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
      existing: { sourcePath: '/diskA/report.pdf', sha256: sha('a') },
      incoming: { sourcePath: '/diskB/report.pdf', sha256: sha('b') },
    });
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
