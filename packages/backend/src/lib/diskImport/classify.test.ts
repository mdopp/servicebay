import { describe, it, expect } from 'vitest';
import {
  classifyRecord,
  dispositionCategory,
  isVideoDominant,
  buildSubtreeHints,
  type ResidueClassifier,
} from './classify';
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

describe('isVideoDominant — image-vs-video subtree heuristic (#1914)', () => {
  it('a folder of only videos is video-dominant', () => {
    expect(isVideoDominant({ imageCount: 0, videoCount: 20 })).toBe(true);
  });
  it('a folder of only images is never video-dominant', () => {
    expect(isVideoDominant({ imageCount: 30, videoCount: 0 })).toBe(false);
  });
  it('a camera roll (lots of photos + a few clips) stays image-dominant', () => {
    expect(isVideoDominant({ imageCount: 200, videoCount: 12 })).toBe(false);
  });
  it('a movie folder (overwhelmingly video, a stray poster image) is video-dominant', () => {
    expect(isVideoDominant({ imageCount: 1, videoCount: 40 })).toBe(true);
  });
  it('an empty folder is not video-dominant', () => {
    expect(isVideoDominant({ imageCount: 0, videoCount: 0 })).toBe(false);
  });
});

describe('classifyRecord — image-vs-video taxonomy split (#1914)', () => {
  it('a video in a video-dominant subtree → movies', () => {
    expect(classifyRecord(rec('/disk/Filme/heist.mkv'), { subtreeVideoDominant: true })).toBe('movies');
  });
  it('a video in an image-dominant subtree stays photos (→ Immich)', () => {
    expect(classifyRecord(rec('/disk/2021/clip.mp4'), { subtreeVideoDominant: false })).toBe('photos');
  });
  it('a lone video with no subtree profile defaults to photos', () => {
    expect(classifyRecord(rec('/disk/clip.mov'))).toBe('photos');
  });
  it('a still image is always photos, even in a video-dominant subtree', () => {
    expect(classifyRecord(rec('/disk/Filme/poster.jpg'), { subtreeVideoDominant: true })).toBe('photos');
  });
});

describe('classifyRecord — forced-type disposition override (#1914)', () => {
  it('explicit Filme→Jellyfin sends a video to movies even when image-dominant', () => {
    expect(
      classifyRecord(rec('/disk/Holiday/clip.mp4'), { subtreeVideoDominant: false }, undefined, 'movies_jellyfin'),
    ).toBe('movies');
  });
  it('a music disposition forces music regardless of extension', () => {
    expect(classifyRecord(rec('/disk/x/track.wav'), {}, undefined, 'music')).toBe('music');
  });
  it('documents_merge forces documents', () => {
    expect(classifyRecord(rec('/disk/x/clip.mp4'), {}, undefined, 'documents_merge')).toBe('documents');
  });
  it('junk is still filtered before a forced disposition applies', () => {
    expect(classifyRecord(rec('/disk/Musik/Thumbs.db'), {}, undefined, 'music')).toBe('junk');
  });
  it('auto / structure dispositions fall through to the content classifier', () => {
    expect(classifyRecord(rec('/disk/song.flac'), {}, undefined, 'auto')).toBe('music');
    expect(classifyRecord(rec('/disk/song.flac'), {}, undefined, 'code_parallel')).toBe('music');
    expect(classifyRecord(rec('/disk/song.flac'), {}, undefined, 'archive_1to1')).toBe('music');
  });
});

describe('dispositionCategory — forced-type map (#1914)', () => {
  const forced: Array<[Parameters<typeof dispositionCategory>[0], Category | null]> = [
    ['photos_immich', 'photos'],
    ['movies_jellyfin', 'movies'],
    ['music', 'music'],
    ['audiobooks', 'audiobooks'],
    ['podcasts', 'podcasts'],
    ['documents_merge', 'documents'],
    ['auto', null],
    ['code_parallel', null],
    ['archive_1to1', null],
    ['skip', null],
  ];
  it.each(forced)('%s → %s', (disposition, expected) => {
    expect(dispositionCategory(disposition)).toBe(expected);
  });
});

describe('buildSubtreeHints — per-folder dominance → movies vs photos (#1914)', () => {
  it('marks videos in a video-dominant folder but not a camera-roll folder', () => {
    const records = [
      // Filme/ — overwhelmingly video → video-dominant.
      ...Array.from({ length: 10 }, (_, i) => rec(`/disk/Filme/movie${i}.mkv`)),
      // 2021/ — a camera roll: lots of photos + a couple clips → image-dominant.
      ...Array.from({ length: 20 }, (_, i) => rec(`/disk/2021/IMG_${i}.jpg`)),
      rec('/disk/2021/clip.mp4'),
    ].map(r => ({ sourcePath: r.sourcePath, ext: r.ext }));

    const hints = buildSubtreeHints(records);

    // A movie in Filme/ routes to movies/.
    expect(classifyRecord(rec('/disk/Filme/movie0.mkv'), hints['/disk/Filme/movie0.mkv'])).toBe('movies');
    // The camera-roll clip stays photos/Immich.
    expect(classifyRecord(rec('/disk/2021/clip.mp4'), hints['/disk/2021/clip.mp4'])).toBe('photos');
    // Images are never tagged.
    expect(hints['/disk/2021/IMG_0.jpg']).toBeUndefined();
  });

  it('leaves non-media folders untouched', () => {
    const hints = buildSubtreeHints([
      { sourcePath: '/disk/docs/a.pdf', ext: 'pdf' },
      { sourcePath: '/disk/music/b.mp3', ext: 'mp3' },
    ]);
    expect(Object.keys(hints)).toHaveLength(0);
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
