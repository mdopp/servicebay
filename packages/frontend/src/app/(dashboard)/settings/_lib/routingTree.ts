// Disk-import review tree — client-side routing resolution (issue #1915).
//
// A small mirror of the backend routing engine (`effectiveRule` /
// `resolveTargetPath`) so the review card can show a LIVE inherited-vs-explicit
// picture and the `data/<owner>/<category>/…` target preview as the user edits,
// without a round-trip per keystroke. The authoritative resolution still runs in
// the engine at apply time; this only drives the preview.
//
// Lives in the feature `_lib/` with relative imports — a frontend util can't use
// `@/lib` (that alias resolves to the BACKEND; memory
// `reference_at_lib_alias_is_backend`).

/** The full v1 disposition set (mirrors the backend `Disposition`). */
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

/** All dispositions in stable presentation order, with plain-language labels. */
export const DISPOSITION_OPTIONS: ReadonlyArray<{ value: Disposition; label: string }> = [
  { value: 'auto', label: 'Auto-sort' },
  { value: 'photos_immich', label: 'Photos & videos → Immich' },
  { value: 'movies_jellyfin', label: 'Movies → Jellyfin' },
  { value: 'music', label: 'Music' },
  { value: 'audiobooks', label: 'Audiobooks' },
  { value: 'podcasts', label: 'Podcasts' },
  { value: 'documents_merge', label: 'Merge documents' },
  { value: 'code_parallel', label: 'Code / keep structure' },
  { value: 'archive_1to1', label: '1:1 archive' },
  { value: 'skip', label: 'Skip (don’t import)' },
];

export type RoutingMode = 'merge' | 'parallel';
export type Owner = 'shared' | string;

/** A node's explicit rule — every axis optional (inherits up-tree). */
export interface Rule {
  disposition?: Disposition;
  mode?: RoutingMode;
  owner?: Owner;
}

/** A fully-resolved rule for a dir (every axis filled, with each axis' anchor). */
export interface ResolvedRule {
  disposition: Disposition;
  mode: RoutingMode;
  owner: Owner;
  /** The dir each axis was inherited FROM (`''` = root/default). */
  anchors: { disposition: string; mode: string; owner: string };
}

/** A directory node in the review tree (mirrors the backend `FolderNode`). */
export interface FolderNode {
  dir: string;
  files: number;
  bytes: number;
  categories: string[];
  explicit: Rule;
  /** The backend-resolved rule (initial render); the card re-resolves on edit. */
  resolved: { disposition: Disposition; mode: RoutingMode; owner: Owner; anchor: string };
}

const ROOT_DEFAULT = { disposition: 'auto' as Disposition, mode: 'merge' as RoutingMode, owner: 'shared' as Owner };

/** Parent of a relative dir, or null at the root (`''`). */
export function parentDir(dir: string): string | null {
  const trimmed = dir.replace(/\/+$/, '');
  if (trimmed === '') return null;
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? '' : trimmed.slice(0, slash);
}

/** Walk up from `dir` to the first ancestor whose rule sets `axis`. */
function resolveAxis(
  dir: string,
  explicit: ReadonlyMap<string, Rule>,
  axis: keyof Rule,
): { value: NonNullable<Rule[keyof Rule]>; anchor: string } | null {
  let cursor: string | null = dir;
  while (cursor !== null) {
    const value = explicit.get(cursor)?.[axis];
    if (value !== undefined) return { value, anchor: cursor };
    cursor = parentDir(cursor);
  }
  return null;
}

/**
 * Resolve `dir`'s effective rule from the explicit map + disk-default owner.
 * Each axis inherits INDEPENDENTLY (owner may anchor at a different dir than
 * disposition). Mirrors the backend `effectiveRule`.
 */
export function effectiveRule(
  dir: string,
  explicit: ReadonlyMap<string, Rule>,
  defaultOwner: Owner = 'shared',
): ResolvedRule {
  const d = resolveAxis(dir, explicit, 'disposition');
  const m = resolveAxis(dir, explicit, 'mode');
  const o = resolveAxis(dir, explicit, 'owner');
  return {
    disposition: (d?.value as Disposition) ?? ROOT_DEFAULT.disposition,
    mode: (m?.value as RoutingMode) ?? ROOT_DEFAULT.mode,
    owner: (o?.value as Owner) ?? defaultOwner ?? ROOT_DEFAULT.owner,
    anchors: { disposition: d?.anchor ?? '', mode: m?.anchor ?? '', owner: o?.anchor ?? '' },
  };
}

/** Whether a node's axis value is INHERITED (not set on the node itself). */
export function isInherited(dir: string, axis: keyof Rule, explicit: ReadonlyMap<string, Rule>): boolean {
  return explicit.get(dir)?.[axis] === undefined;
}

/** Map a disposition to the category folder it FORCES, or null for content-driven. */
const DISPOSITION_FOLDER: Partial<Record<Disposition, string>> = {
  photos_immich: 'photos',
  movies_jellyfin: 'movies',
  music: 'music',
  audiobooks: 'audiobooks',
  podcasts: 'podcasts',
  documents_merge: 'documents',
};

/**
 * The resolved-target PREVIEW for a folder under `data/`: `data/<owner?>/<cat>/…`.
 * Uses the folder's own dominant category when the disposition is content-driven
 * (`auto`/`code_parallel`/`archive_1to1`), else the forced category. `skip`
 * folders aren't imported. Advisory preview only — the engine is authoritative.
 */
export function targetPreview(resolved: ResolvedRule, ownCategories: string[]): string {
  if (resolved.disposition === 'skip') return 'Skipped — not imported';
  const forced = DISPOSITION_FOLDER[resolved.disposition];
  const category = forced ?? ownCategories[0] ?? 'documents';
  const ownerSeg = resolved.owner === 'shared' ? '' : `${resolved.owner}/`;
  return `data/${ownerSeg}${category}/…`;
}
