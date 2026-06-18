// Disk-import routing-tree review UI — wire types (#2000).
//
// These mirror the backend `buildReviewTree` response + the engine Rule/Owner/
// Disposition shapes. They live HERE (a feature-local `_lib`, relative import)
// rather than importing `@servicebay/disk-import-worker`: that barrel pulls
// better-sqlite3 + node:fs (catalog.ts/hostExec.ts) and would break the browser
// bundle. The route validates the values server-side; the UI only needs the shapes.

export type Owner = string; // `shared` or a box-user id.
export type RoutingMode = 'merge' | 'parallel';
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

/** A folder's explicit (partial) routing rule — every axis optional. */
export interface Rule {
  disposition?: Disposition;
  mode?: RoutingMode;
  owner?: Owner;
}

/** A folder's fully-resolved rule (inherited where not explicit) + the anchor. */
export interface ResolvedRule {
  disposition: Disposition;
  mode: RoutingMode;
  owner: Owner;
  anchor: string;
}

/** One review-tree node (folder rollup + resolved rule + live target preview). */
export interface ReviewNode {
  dir: string;
  files: number;
  bytes: number;
  categories: string[];
  explicit: Rule;
  resolved: ResolvedRule;
  preview: string;
}

export interface ReviewOwner {
  id: Owner;
  label: string;
}

export interface ReviewTree {
  ok: boolean;
  tree: ReviewNode[];
  owners: ReviewOwner[];
  dispositions: Disposition[];
  mountBase: string;
}

/** Human label for each disposition in the target picker. */
export const DISPOSITION_LABELS: Record<Disposition, string> = {
  auto: 'Auto-sort',
  photos_immich: 'Photos & videos → Immich',
  movies_jellyfin: 'Movies → Jellyfin',
  music: 'Music',
  audiobooks: 'Audiobooks',
  podcasts: 'Podcasts',
  documents_merge: 'Documents (merge)',
  code_parallel: 'Code / folders (keep structure)',
  archive_1to1: 'Archive 1:1',
  skip: 'Skip (don’t import)',
};
