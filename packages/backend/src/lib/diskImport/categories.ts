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
}

/**
 * The fixed category → folder + extension map. `junk` has no folder (files are
 * skipped) — its `extensions` list is empty because junk is matched by name
 * pattern (thumbs.db, .ds_store, *.tmp, caches), see classify.ts.
 */
export const CATEGORIES: Record<Category, CategoryDef> = {
  photos: {
    folder: 'photos/',
    // Photos + personal video.
    extensions: [
      'jpg', 'jpeg', 'heic', 'heif', 'png', 'gif', 'webp', 'tiff', 'tif', 'bmp',
      'raw', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'dng',
      'mov', 'mp4', 'm4v', 'avi', 'mkv', '3gp',
    ],
  },
  music: {
    folder: 'music/',
    extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'aiff'],
  },
  audiobooks: {
    folder: 'audiobooks/',
    // m4b is unambiguously an audiobook; mp3 audiobooks are reclassified out of
    // `music` by heuristic / LLM (classify.ts).
    extensions: ['m4b', 'aax', 'aa'],
  },
  podcasts: {
    folder: 'podcasts/',
    // No extensions are podcast-exclusive — podcasts are detected by heuristic /
    // LLM from the (audio) residue, not by extension.
    extensions: [],
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
  },
  junk: {
    folder: '',
    extensions: [],
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

/** Path segments (lower-case) that mark a whole subtree as junk/cache. */
export const JUNK_PATH_SEGMENTS: ReadonlyArray<string> = [
  '.trash',
  '.trashes',
  '.spotlight-v100',
  '.fseventsd',
  '@eadir', // Synology thumbnail caches
  '__macosx',
  'node_modules',
];
