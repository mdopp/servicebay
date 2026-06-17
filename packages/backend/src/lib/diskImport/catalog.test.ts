import { describe, it, expect, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { ImportCatalog, type CatalogEntry } from './catalog';

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  sha256: 'a'.repeat(64),
  area: 'shared',
  target: 'photos/IMG_0001.jpg',
  sourcePath: '/disk/IMG_0001.jpg',
  size: 1234,
  importedAtMs: 1000,
  ...over,
});

describe('ImportCatalog — in-memory round-trips', () => {
  it('upsert → has / get', () => {
    const cat = new ImportCatalog(':memory:');
    expect(cat.has(entry().sha256, entry().target)).toBe(false);
    cat.upsert(entry());
    expect(cat.has(entry().sha256, entry().target)).toBe(true);
    expect(cat.get(entry().sha256, entry().target)).toEqual(entry());
    expect(cat.count()).toBe(1);
    cat.close();
  });

  it('upsert is idempotent on (sha256, target) and updates mutable fields', () => {
    const cat = new ImportCatalog(':memory:');
    cat.upsert(entry());
    cat.upsert(entry({ sourcePath: '/disk2/copy.jpg', importedAtMs: 2000 }));
    expect(cat.count()).toBe(1);
    expect(cat.get(entry().sha256, entry().target)?.sourcePath).toBe('/disk2/copy.jpg');
    expect(cat.get(entry().sha256, entry().target)?.importedAtMs).toBe(2000);
    cat.close();
  });

  it('findBySha returns all targets for a hash', () => {
    const cat = new ImportCatalog(':memory:');
    cat.upsert(entry({ target: 'photos/a.jpg' }));
    cat.upsert(entry({ target: 'photos/b.jpg' }));
    const hits = cat.findBySha(entry().sha256);
    expect(hits.map(h => h.target)).toEqual(['photos/a.jpg', 'photos/b.jpg']);
    cat.close();
  });

  it('getByTarget finds the row by destination path', () => {
    const cat = new ImportCatalog(':memory:');
    cat.upsert(entry());
    expect(cat.getByTarget('photos/IMG_0001.jpg')?.sha256).toBe(entry().sha256);
    expect(cat.getByTarget('photos/missing.jpg')).toBeUndefined();
    cat.close();
  });

  it('defaults a missing area to shared', () => {
    const cat = new ImportCatalog(':memory:');
    // Upsert without an explicit area → stored under DEFAULT_AREA ('shared').
    cat.upsert({ ...entry(), area: undefined });
    expect(cat.has(entry().sha256, entry().target)).toBe(true);
    expect(cat.get(entry().sha256, entry().target)?.area).toBe('shared');
    cat.close();
  });

  it('scopes dedup by area: same (sha, target) in two areas are distinct rows', () => {
    const cat = new ImportCatalog(':memory:');
    // Same bytes + same target path, one shared and one in a user area.
    cat.upsert(entry({ area: 'shared' }));
    cat.upsert(entry({ area: 'cdopp' }));
    expect(cat.count()).toBe(2);
    // A private area dedups within itself; shared is a separate slot.
    expect(cat.has(entry().sha256, entry().target, 'shared')).toBe(true);
    expect(cat.has(entry().sha256, entry().target, 'cdopp')).toBe(true);
    expect(cat.has(entry().sha256, entry().target, 'mdopp')).toBe(false);
    // getByTarget is area-scoped too.
    expect(cat.getByTarget(entry().target, 'cdopp')?.area).toBe('cdopp');
    expect(cat.getByTarget(entry().target, 'mdopp')).toBeUndefined();
    cat.close();
  });
});

describe('ImportCatalog — persist + reload from a file path', () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('survives close + reopen at the same path', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'diskimport-cat-'));
    const dbPath = path.join(tmpDir, 'catalog.db');

    const first = new ImportCatalog(dbPath);
    first.upsert(entry());
    first.upsert(entry({ sha256: 'b'.repeat(64), target: 'music/song.flac' }));
    expect(first.count()).toBe(2);
    first.close();

    const reopened = new ImportCatalog(dbPath);
    expect(reopened.count()).toBe(2);
    expect(reopened.has('b'.repeat(64), 'music/song.flac')).toBe(true);
    expect(reopened.get(entry().sha256, entry().target)).toEqual(entry());
    reopened.close();
  });
});
