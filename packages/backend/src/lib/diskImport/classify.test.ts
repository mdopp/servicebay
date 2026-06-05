import { describe, it, expect } from 'vitest';
import { classifyRecord, type ResidueClassifier } from './classify';
import { toRecord } from './inventory';
import type { Category } from './types';

function rec(path: string, extra: Partial<{ size: number; mtimeMs: number }> = {}) {
  return toRecord({ path, size: extra.size ?? 1000, mtimeMs: extra.mtimeMs ?? 0 });
}

describe('classifyRecord — extension map', () => {
  const cases: Array<[string, Category]> = [
    ['/disk/IMG_0001.JPG', 'photos'],
    ['/disk/sunset.heic', 'photos'],
    ['/disk/raw/shot.cr2', 'photos'],
    ['/disk/clip.mov', 'photos'],
    ['/disk/holiday.mp4', 'photos'],
    ['/disk/song.flac', 'music'],
    ['/disk/track.m4a', 'music'],
    ['/disk/book.m4b', 'audiobooks'],
    ['/disk/manual.pdf', 'documents'],
    ['/disk/notes.txt', 'documents'],
    ['/disk/novel.epub', 'documents'],
  ];
  it.each(cases)('%s → %s', (path, expected) => {
    expect(classifyRecord(rec(path))).toBe(expected);
  });
});

describe('classifyRecord — junk', () => {
  it('skips known junk names', () => {
    expect(classifyRecord(rec('/disk/Thumbs.db'))).toBe('junk');
    expect(classifyRecord(rec('/disk/.DS_Store'))).toBe('junk');
    expect(classifyRecord(rec('/disk/desktop.ini'))).toBe('junk');
  });
  it('skips junk extensions', () => {
    expect(classifyRecord(rec('/disk/foo.tmp'))).toBe('junk');
    expect(classifyRecord(rec('/disk/half.part'))).toBe('junk');
  });
  it('skips junk path segments / caches', () => {
    expect(classifyRecord(rec('/disk/@eaDir/song.flac'))).toBe('junk');
    expect(classifyRecord(rec('/disk/__MACOSX/IMG.jpg'))).toBe('junk');
    expect(classifyRecord(rec('.Trash/x.pdf'))).toBe('junk');
  });
});

describe('classifyRecord — music vs audiobook disambiguation', () => {
  it('plain mp3 with no signal stays music', () => {
    expect(classifyRecord(rec('/disk/Artist/Album/01 Song.mp3'))).toBe('music');
  });

  it('mp3 under an audiobook folder is an audiobook', () => {
    expect(classifyRecord(rec('/disk/Audiobooks/Dune/ch01.mp3'))).toBe('audiobooks');
  });

  it('German "Hörbuch" path hint → audiobook', () => {
    expect(classifyRecord(rec('/disk/Hörbuch/Buch/teil1.mp3'))).toBe('audiobooks');
  });

  it('ID3 spoken-word genre → audiobook', () => {
    expect(classifyRecord(rec('/disk/x/track.mp3'), { genre: 'Audiobook' })).toBe('audiobooks');
  });

  it('chapter naming hint → audiobook', () => {
    expect(classifyRecord(rec('/disk/x/track.mp3'), { chapterNaming: true })).toBe('audiobooks');
  });

  it('long average track length → audiobook', () => {
    expect(classifyRecord(rec('/disk/x/track.mp3'), { avgTrackLengthSec: 45 * 60 })).toBe('audiobooks');
  });

  it('short average track length stays music', () => {
    expect(classifyRecord(rec('/disk/x/track.mp3'), { avgTrackLengthSec: 200 })).toBe('music');
  });

  it('podcast path hint → podcasts', () => {
    expect(classifyRecord(rec('/disk/Podcasts/show/ep1.mp3'))).toBe('podcasts');
  });

  it('podcast genre → podcasts', () => {
    expect(classifyRecord(rec('/disk/x/ep.mp3'), { genre: 'Podcast' })).toBe('podcasts');
  });

  it('m4b is unconditionally an audiobook (no music refinement)', () => {
    expect(classifyRecord(rec('/disk/Music/whatever.m4b'))).toBe('audiobooks');
  });
});

describe('classifyRecord — residue (LLM seam)', () => {
  it('returns null for unknown extension with no residue classifier', () => {
    expect(classifyRecord(rec('/disk/mystery.xyz'))).toBeNull();
  });

  it('consults the injected residue classifier for unknowns', () => {
    const residue: ResidueClassifier = {
      suggest: () => 'documents',
    };
    expect(classifyRecord(rec('/disk/mystery.xyz'), {}, residue)).toBe('documents');
  });

  it('does NOT consult the residue classifier when extension already resolves', () => {
    const residue: ResidueClassifier = {
      suggest: () => {
        throw new Error('should not be called');
      },
    };
    expect(classifyRecord(rec('/disk/song.flac'), {}, residue)).toBe('music');
  });
});
