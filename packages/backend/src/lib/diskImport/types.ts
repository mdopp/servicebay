// Disk-import engine — shared types.
//
// Pure data shapes for the deterministic core of the disk-import feature
// (issue #1693). No I/O lives here.

/** A canonical category a file can be sorted into. `junk` means "skip". */
export type Category =
  | 'photos'
  | 'music'
  | 'audiobooks'
  | 'podcasts'
  | 'documents'
  | 'junk';

/**
 * One scanned file, metadata-only. The inventory step produces these from a
 * provided file list — the engine never reads file contents or walks a disk.
 */
export interface ImportRecord {
  /** Source path on the imported tree, as scanned. */
  sourcePath: string;
  /** File size in bytes. */
  size: number;
  /** Last-modified time, epoch milliseconds. */
  mtimeMs: number;
  /** Lower-cased extension WITHOUT the leading dot (e.g. `jpg`), `''` if none. */
  ext: string;
  /** Lower-cased base file name (e.g. `thumbs.db`). */
  name: string;
  /**
   * Content hash (sha256, hex). Optional — the inventory step is
   * metadata-first, so this is filled in later (by dedup, when a hash is
   * actually needed to disambiguate same-size candidates).
   */
  sha256?: string;
}

/** The action the plan assigns to a record. */
export type ImportAction = 'copy' | 'skip-junk' | 'skip-dupe' | 'conflict';

/** One planned entry: a record, where it goes, and what to do with it. */
export interface ImportPlanItem {
  record: ImportRecord;
  category: Category;
  /**
   * Target path relative to `file-share/data/` (e.g. `photos/IMG_0001.jpg`),
   * or `null` for junk (nothing is written).
   */
  target: string | null;
  action: ImportAction;
}

/**
 * Two distinct files (different content) that resolve to the same target
 * path. The importer must not silently overwrite — these surface for review.
 */
export interface Conflict {
  /** The shared target path the colliding files both map to. */
  target: string;
  /** The record already accounted for (in-tree winner or catalog entry). */
  existing: { sourcePath: string; sha256: string };
  /** The record that collides with it. */
  incoming: { sourcePath: string; sha256: string };
}

/** The full deterministic output of a run over a scanned file list. */
export interface ImportPlan {
  items: ImportPlanItem[];
  conflicts: Conflict[];
}
