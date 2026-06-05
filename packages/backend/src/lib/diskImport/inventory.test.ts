import { describe, it, expect } from 'vitest';
import { buildInventory, extOf, baseName, toRecord } from './inventory';

describe('extOf', () => {
  it('lower-cases and strips the dot', () => {
    expect(extOf('/disk/IMG_0001.JPG')).toBe('jpg');
    expect(extOf('a/b/song.FLAC')).toBe('flac');
  });
  it('treats a leading-dot dotfile as having no extension', () => {
    expect(extOf('/disk/.DS_Store')).toBe('');
    expect(extOf('.gitignore')).toBe('');
  });
  it('returns empty for no extension', () => {
    expect(extOf('/disk/README')).toBe('');
  });
  it('uses the last dot for multi-dot names', () => {
    expect(extOf('archive.tar.gz')).toBe('gz');
  });
});

describe('baseName', () => {
  it('handles both separators and lower-cases', () => {
    expect(baseName('/disk/sub/File.PDF')).toBe('file.pdf');
    expect(baseName('C:\\Users\\me\\Doc.TXT')).toBe('doc.txt');
  });
});

describe('toRecord / buildInventory', () => {
  it('maps metadata into a record without reading content', () => {
    const r = toRecord({ path: '/disk/x.mp3', size: 99, mtimeMs: 123 });
    expect(r).toEqual({
      sourcePath: '/disk/x.mp3',
      size: 99,
      mtimeMs: 123,
      ext: 'mp3',
      name: 'x.mp3',
      sha256: undefined,
    });
  });
  it('preserves a provided hash', () => {
    const r = toRecord({ path: '/disk/x.mp3', size: 1, mtimeMs: 0, sha256: 'deadbeef' });
    expect(r.sha256).toBe('deadbeef');
  });
  it('sorts the inventory by source path', () => {
    const inv = buildInventory([
      { path: '/disk/z', size: 0, mtimeMs: 0 },
      { path: '/disk/a', size: 0, mtimeMs: 0 },
    ]);
    expect(inv.map(r => r.sourcePath)).toEqual(['/disk/a', '/disk/z']);
  });
});
