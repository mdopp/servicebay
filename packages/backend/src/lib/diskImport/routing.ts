// Disk-import engine — routing-tree resolution (issue #1912, parent epic #1901).
//
// Pure helpers over the per-folder routing tree: resolve a directory's effective
// rule by walking up the tree (each axis — disposition / mode / owner —
// inherited INDEPENDENTLY of the others), seed owners from an exact top-level
// source-dir name matching a box user, and derive the per-disposition dedup
// "destination area" that scopes the catalog/hash key.
//
// NO I/O here. The box-user list is INJECTED by the caller (sourced from the
// authoritative directory — `listLldapUsers()`/the file-share Samba accounts —
// at the boundary, never hardcoded in the engine). Target-path resolution is
// #1913, the taxonomy/movies split is #1914, the review UI is #1915 — this unit
// models the data + resolution only.

import type {
  BoxUserId,
  Disposition,
  Owner,
  ResolvedRule,
  Rule,
  RoutingMode,
} from './types';

/** The default rule at the tree root when nothing else is set. */
export const ROOT_DEFAULT: Required<Omit<ResolvedRule, 'anchor'>> = {
  disposition: 'auto',
  mode: 'merge',
  owner: 'shared',
};

/**
 * Dispositions whose destination area is DEDUPED (content-hashed, duplicates
 * collapse): `auto` sorts into shared library categories and `documents_merge`
 * intentionally merges multiple sources. `photos_immich`/`movies_jellyfin` and
 * the audio types dedup server-side / on a later pass; `code_parallel`,
 * `archive_1to1` and `skip` must NEVER dedup (structure is load-bearing).
 */
const DEDUP_DISPOSITIONS: ReadonlySet<Disposition> = new Set<Disposition>([
  'auto',
  'documents_merge',
]);

/** True iff this disposition's destination area dedups (hashes for duplicates). */
export function dedupsFor(disposition: Disposition): boolean {
  return DEDUP_DISPOSITIONS.has(disposition);
}

// --- tree navigation -------------------------------------------------------

/**
 * The parent of a POSIX-style relative directory path, or `null` at the root.
 * The root is the empty string `''` (the tree's top). Trailing slashes are
 * ignored; a single-segment dir's parent is the root.
 */
export function parentDir(dir: string): string | null {
  const trimmed = dir.replace(/\/+$/, '');
  if (trimmed === '') return null;
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? '' : trimmed.slice(0, slash);
}

/** The exact top-level segment of a dir (`Backup-2023` for `Backup-2023/x/y`). */
export function topLevelSegment(dir: string): string {
  const trimmed = dir.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return '';
  const slash = trimmed.indexOf('/');
  return slash === -1 ? trimmed : trimmed.slice(0, slash);
}

// --- effective rule (per-axis inheritance) ---------------------------------

/**
 * Resolve the effective rule for `dir` by walking up the tree. Each axis is
 * resolved INDEPENDENTLY: a node may set `owner` while inheriting `disposition`
 * from one ancestor and `mode` from another. The `anchor` is the nearest
 * ancestor (or the node itself) that supplied the *disposition* — the base
 * #1913 uses for relative-path math; owner/mode may anchor higher and that is
 * intentional (owner inherits separately from disposition).
 *
 * @param explicit map of relDir → the (partial) Rule the user set on that node
 * @param rootDefault optional override of ROOT_DEFAULT (e.g. a disk-default owner)
 */
export function effectiveRule(
  dir: string,
  explicit: ReadonlyMap<string, Rule>,
  rootDefault: Partial<Rule> = {},
): ResolvedRule {
  const base: ResolvedRule = {
    disposition: rootDefault.disposition ?? ROOT_DEFAULT.disposition,
    mode: rootDefault.mode ?? ROOT_DEFAULT.mode,
    owner: rootDefault.owner ?? ROOT_DEFAULT.owner,
    anchor: '',
  };

  // Resolve each axis on its own ladder so owner and mode never couple.
  const disposition = resolveAxis(dir, explicit, 'disposition');
  const mode = resolveAxis(dir, explicit, 'mode');
  const owner = resolveAxis(dir, explicit, 'owner');

  return {
    disposition: (disposition?.value as Disposition | undefined) ?? base.disposition,
    mode: (mode?.value as RoutingMode | undefined) ?? base.mode,
    owner: (owner?.value as Owner | undefined) ?? base.owner,
    // Anchor follows the disposition axis (it drives relative-path math in #1913);
    // falls back to the root when the disposition is inherited from the default.
    anchor: disposition?.anchor ?? '',
  };
}

/** Walk up from `dir` to the first ancestor whose rule sets `axis`. */
function resolveAxis(
  dir: string,
  explicit: ReadonlyMap<string, Rule>,
  axis: keyof Rule,
): { value: NonNullable<Rule[keyof Rule]>; anchor: string } | null {
  let cursor: string | null = dir;
  while (cursor !== null) {
    const rule = explicit.get(cursor);
    const value = rule?.[axis];
    if (value !== undefined) return { value, anchor: cursor };
    cursor = parentDir(cursor);
  }
  return null;
}

// --- exact-top-level-name owner auto-assign --------------------------------

/**
 * Seed owners onto the explicit rule map from the box-user list: any TOP-LEVEL
 * source directory named EXACTLY like a box user (e.g. source `mdopp/` →
 * owner `mdopp`) gets that owner pre-assigned. Returns a NEW map (input is not
 * mutated); a user who already set an explicit owner on that node is left
 * untouched (the auto-assign is overridable / never clobbers an explicit pick).
 * Matching is exact and case-sensitive — the box-user ids are the canonical
 * lower-case directory convention.
 *
 * @param topLevelDirs the source's top-level directory names (relDir, one segment)
 * @param boxUsers the injected box-user list (e.g. ['mdopp','cdopp','ddopp'])
 * @param explicit the current explicit-rule map (any prior user edits)
 */
export function autoAssignOwners(
  topLevelDirs: readonly string[],
  boxUsers: readonly BoxUserId[],
  explicit: ReadonlyMap<string, Rule> = new Map(),
): Map<string, Rule> {
  const users = new Set(boxUsers);
  const next = new Map<string, Rule>(explicit);
  for (const dir of topLevelDirs) {
    const name = topLevelSegment(dir);
    if (!users.has(name)) continue;
    const current = next.get(name);
    // Never override an owner the user already set on this node.
    if (current?.owner !== undefined) continue;
    next.set(name, { ...current, owner: name });
  }
  return next;
}

// --- dedup destination area -------------------------------------------------

/**
 * The "destination area" that scopes the dedup/catalog key for a resolved rule.
 * A private (user-owned) area dedups WITHIN ITSELF; `shared` merges across
 * users. Folding this into the catalog/hash key (dedup.ts/catalog.ts) means the
 * same bytes can live once per user area AND once in shared, intentionally —
 * `data/mdopp/photos/x.jpg` and `data/cdopp/photos/x.jpg` are not duplicates,
 * but two `shared` sources hitting `data/photos/x.jpg` are.
 *
 *   owner 'shared'  → 'shared'
 *   owner user 'u'  → 'u'
 */
export function destinationArea(owner: Owner): string {
  return owner === 'shared' ? 'shared' : owner;
}
