// Disk-import engine — the fixed canonical category map (issue #1693).
//
// This is the ONLY place the category taxonomy lives. The engine sorts files
// into these categories and nothing else; it holds no service list and asks
// no service anything. Whatever software watches a folder (`music/` → a music
// server, `podcasts/` → a podcast app) is irrelevant to the importer.
//
// Extending the engine = adding one line here.

import type { Category } from './types';

// All category folders live under `file-share/data/` on the share (lower-case
// convention, #1018). Folder values below — and every `target` the engine
// emits — are RELATIVE to that root; the host-apply step (a later issue) joins
// them onto the real mount point.

/**
 * How a category lays out its files in the library (#2006 redesign):
 *  - `preserve` — keep the source sub-folders under the category root
 *    (`documents/holiday/notes/a.txt`). Distinct files in different folders never
 *    collide, so their structure + context survive.
 *  - `flat` — drop the source path; everything lands directly in the category
 *    folder by basename (`music/track01.mp3`). The directory a file sat in is noise.
 */
export type CategoryLayout = 'preserve' | 'flat';

/**
 * What makes two files "the same" for dedup (#2006 redesign):
 *  - `content` — identical BYTES (fingerprint/sha). A reused name (`IMG_0001.jpg`
 *    from two cameras) is two DIFFERENT files → both kept; only byte-identical
 *    copies collapse. Right for photos/videos/documents.
 *  - `nameSize` — same FILENAME + byte-size, regardless of directory. Right for
 *    music: the same track scattered across folders is one song; needs NO hashing.
 *    Size guards against two distinct songs sharing a generic name (`01.mp3`).
 */
export type CategoryIdentity = 'content' | 'nameSize';

export interface CategoryDef {
  /**
   * Folder under `file-share/data/`, lower-case (convention #1018), trailing
   * slash. `documents/` is the base; topic sub-foldering (`documents/<topic>/`)
   * is decided by the LLM-residue path in a later issue, not here.
   */
  folder: string;
  /**
   * Extensions (lower-case, no dot) that map to this category by the plain
   * extension rule. Ambiguous extensions (e.g. `mp3` can be music OR an
   * audiobook) are resolved by heuristics in classify.ts, not here.
   */
  extensions: string[];
  /** How files lay out in the library (preserve source folders vs flatten). */
  layout: CategoryLayout;
  /** What counts as a duplicate (bytes vs name+size). */
  identity: CategoryIdentity;
}

/**
 * The fixed category → folder + extension map. `junk` has no folder (files are
 * skipped) — its `extensions` list is empty because junk is matched by name
 * pattern (thumbs.db, .ds_store, *.tmp, caches), see classify.ts.
 */
export const CATEGORIES: Record<Category, CategoryDef> = {
  photos: {
    folder: 'photos/',
    // Photos + personal video. Video extensions are shared with `movies`
    // (below); the extension map's first-wins rule keeps a lone video in
    // `photos` (→ Immich) by default — the image-vs-video subtree heuristic
    // and an explicit `movies_jellyfin` disposition (classify.ts, #1914) are
    // what redirect a video-dominant subtree to `movies/`.
    extensions: [
      'jpg', 'jpeg', 'heic', 'heif', 'png', 'gif', 'webp', 'tiff', 'tif', 'bmp',
      'raw', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'dng',
      'mov', 'mp4', 'm4v', 'avi', 'mkv', '3gp',
    ],
    // A reused name (every camera's IMG_0001.jpg) is a DIFFERENT photo → identity
    // is bytes only; keep source folders so distinct photos coexist (Immich
    // reorganizes by EXIF date regardless).
    layout: 'preserve',
    identity: 'content',
  },
  movies: {
    folder: 'movies/',
    // No EXCLUSIVE extensions: every video extension is already claimed by
    // `photos` above (first-wins). A file only lands in `movies/` when the
    // subtree is video-dominant or carries an explicit `movies_jellyfin`
    // disposition (classify.ts) — never by the bare extension rule.
    extensions: [],
    layout: 'preserve',
    identity: 'content',
  },
  music: {
    folder: 'music/',
    extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'aiff'],
    // The same track scattered across folders is one song → flatten + dedup by
    // name+size (no hashing). Two distinct songs sharing a generic name differ in
    // size, so they're kept (and the loser of a flat-name clash is renamed).
    layout: 'flat',
    identity: 'nameSize',
  },
  audiobooks: {
    folder: 'audiobooks/',
    // m4b is unambiguously an audiobook; mp3 audiobooks are reclassified out of
    // `music` by heuristic / LLM (classify.ts). Series chapters reuse names like
    // `01.mp3` across books → identity is bytes, structure preserved.
    extensions: ['m4b', 'aax', 'aa'],
    layout: 'preserve',
    identity: 'content',
  },
  podcasts: {
    folder: 'podcasts/',
    // No extensions are podcast-exclusive — podcasts are detected by heuristic /
    // LLM from the (audio) residue, not by extension.
    extensions: [],
    layout: 'preserve',
    identity: 'content',
  },
  documents: {
    folder: 'documents/',
    extensions: [
      'pdf', 'doc', 'docx', 'txt', 'rtf', 'odt',
      'epub', 'mobi', 'azw3',
      'xls', 'xlsx', 'ods', 'csv',
      'ppt', 'pptx', 'odp',
      'md', 'html', 'htm',
    ],
    // docs/note1.txt and notes/note1.txt are different files → keep folders;
    // identical bytes across yearly backups collapse by content.
    layout: 'preserve',
    identity: 'content',
  },
  junk: {
    // Never written — defaults are placeholders so the map stays total.
    folder: '',
    extensions: [],
    layout: 'flat',
    identity: 'content',
  },
};

/**
 * Build the extension → category lookup from CATEGORIES. The first category to
 * claim an extension wins (insertion order of CATEGORIES), so the map above is
 * authored without overlap. Frozen so callers can't mutate the shared table.
 */
function buildExtensionIndex(): ReadonlyMap<string, Category> {
  const index = new Map<string, Category>();
  for (const cat of Object.keys(CATEGORIES) as Category[]) {
    for (const ext of CATEGORIES[cat].extensions) {
      if (!index.has(ext)) index.set(ext, cat);
    }
  }
  return index;
}

export const EXTENSION_INDEX: ReadonlyMap<string, Category> = buildExtensionIndex();

/**
 * Image extensions (the still-photo half of the `photos` bucket). Used by the
 * image-vs-video subtree heuristic (#1914) to decide whether a video-extension
 * file sitting in a mostly-image folder is personal media (→ Immich/`photos`)
 * or a mostly-video folder that should go to `movies/`.
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg', 'jpeg', 'heic', 'heif', 'png', 'gif', 'webp', 'tiff', 'tif', 'bmp',
  'raw', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'dng',
]);

/** Video extensions shared between `photos` (personal video) and `movies/`. */
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mov', 'mp4', 'm4v', 'avi', 'mkv', '3gp',
]);

/** File-name patterns (lower-case) that mark a file as junk and skipped. */
export const JUNK_NAMES: ReadonlySet<string> = new Set([
  'thumbs.db',
  '.ds_store',
  'desktop.ini',
  '.localized',
]);

/** Junk extensions (lower-case, no dot) — caches and transient files. */
export const JUNK_EXTENSIONS: ReadonlySet<string> = new Set([
  'tmp', 'temp', 'cache', 'part', 'crdownload', 'bak',
]);

/**
 * Path segments (lower-case) that mark a whole subtree as junk/cache. These are
 * also pruned at the host `find` walk (hostScan.ts) so the importer never
 * descends, enumerates or hashes them — a repo-heavy disk's `node_modules`/`.git`
 * never enter the inventory (#1932).
 */
export const JUNK_PATH_SEGMENTS: ReadonlyArray<string> = [
  '.trash',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd',
  '@eadir', // Synology thumbnail caches
  '__macosx',
  'node_modules',
  '.git', // git internals are never library content (#1932)
  // Dev / build / cache subtrees (#1937): checked-in dependency trees and
  // generated/build output that flood a repo-heavy disk's inventory + dedup
  // hash pass with near-identical, size-colliding files — never library
  // content. `bower_components` was the biggest single offender on the user's
  // real disk (~5.6k checked-in Polymer deps).
  'bower_components',
  'vendor', // Go/PHP vendored deps
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.gradle',
  '.cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  '.svn', // other VCS internals
  '.hg',
];
