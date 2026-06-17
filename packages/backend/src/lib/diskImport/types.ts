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

// ---------------------------------------------------------------------------
// Routing tree (issue #1912, parent epic #1901)
//
// The per-folder routing tree adds three orthogonal axes to a source folder:
//   WHAT  — the `Disposition` (content/destination intent),
//   HOW   — the `RoutingMode` (merge vs parallel structure),
//   WHO   — the `Owner` (shared, or a specific box user).
// All three are INHERITED down the tree and resolved independently of one
// another by `effectiveRule` (routing.ts). This file models the SHAPES only —
// inheritance/auto-assign live in routing.ts, target-path math is #1913, the
// taxonomy/movies split is #1914, the review UI is #1915.
// ---------------------------------------------------------------------------

/**
 * The full v1 disposition set (WHAT a folder's contents are, per epic #1901
 * Q1). Stable enum keys; the German preset names from the issue map as:
 *   auto              → "Auto-sortieren"
 *   photos_immich     → "Fotos & Videos → Immich"
 *   movies_jellyfin   → "Filme → Jellyfin"
 *   music             → "Musik"
 *   audiobooks        → "Hörbücher"
 *   podcasts          → "Podcasts"
 *   documents_merge   → "Dokumente zusammenführen"
 *   code_parallel     → "Quellcode/Ordner parallel"
 *   archive_1to1      → "1:1 Archiv"
 *   skip              → "Überspringen"
 *
 * Per-disposition dedup intent (whether the catalog/hash dedups within the
 * destination area) is expressed by `DEDUP_DISPOSITIONS`/`dedupsFor` (routing.ts);
 * structure (flatten vs preserve) is the orthogonal `RoutingMode`.
 */
export type Disposition =
  | 'auto'
  | 'photos_immich'
  | 'movies_jellyfin'
  | 'music'
  | 'audiobooks'
  | 'podcasts'
  | 'documents_merge'
  | 'code_parallel'
  | 'archive_1to1'
  | 'skip';

/** All disposition keys, in stable presentation order. */
export const DISPOSITIONS: readonly Disposition[] = [
  'auto',
  'photos_immich',
  'movies_jellyfin',
  'music',
  'audiobooks',
  'podcasts',
  'documents_merge',
  'code_parallel',
  'archive_1to1',
  'skip',
] as const;

/**
 * HOW the contents are combined/structured (resolved independently of WHAT and
 * WHO). `merge` flattens several sources into one target folder (dedups across
 * them); `parallel` keeps each source's subtree intact (no cross-source merge).
 * Target-path resolution from this is #1913 — modelled here, not applied.
 */
export type RoutingMode = 'merge' | 'parallel';

/** A box user id (e.g. `mdopp`). Sourced from the box-user list, not hardcoded. */
export type BoxUserId = string;

/**
 * WHO owns a subtree: `shared` (lands under `data/<category>/…`) or a specific
 * box user (lands under `data/<userId>/<category>/…`). Resolved up the tree
 * INDEPENDENTLY of disposition/mode by `effectiveRule`.
 */
export type Owner = 'shared' | BoxUserId;

/**
 * A node's explicit routing rule. Every field is optional EXCEPT in the root
 * default — a child node may set only the axis the user touched; the rest
 * inherit from the nearest ancestor that set them. `effectiveRule` resolves
 * each axis up the tree on its own.
 */
export interface Rule {
  disposition?: Disposition;
  /** merge vs parallel — only meaningful for structure-preserving dispositions. */
  mode?: RoutingMode;
  /** `shared` or a box user id. Inherits up-tree independently of `mode`. */
  owner?: Owner;
}

/**
 * The fully-resolved rule for a directory: every axis filled (from the node or
 * an ancestor), plus the `anchor` — the directory that supplied the rule, which
 * #1913 uses as the base for a file's relative path on copy.
 */
export interface ResolvedRule {
  disposition: Disposition;
  mode: RoutingMode;
  owner: Owner;
  /** The directory whose explicit rule / the root default supplied this. */
  anchor: string;
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
