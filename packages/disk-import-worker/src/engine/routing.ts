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

import { CATEGORIES } from './categories';
import type {
  BoxUserId,
  Category,
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

// --- target-path resolution (issue #1913) ----------------------------------
//
// Derive a file's TARGET path (relative to `file-share/data/`) from its resolved
// routing rule (disposition + mode + owner). Lives here (not plan.ts) so the
// dedup/plan builder can resolve owner-aware targets WITHOUT a dedup↔plan import
// cycle; plan.ts re-exports it for the apply path.
//
//   owner 'shared'  → `<category>/…`            (no owner segment)
//   owner user 'u'  → `<u>/<category>/…`
//   mode  'merge'   → flatten to the category folder (basename only)
//   mode  'parallel'→ preserve the source subtree BELOW the rule's anchor

/** Normalised relative path: forward slashes, no leading/trailing slash, no `.`/empty segs. */
function relSegments(relPath: string): string[] {
  return relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter(s => s !== '' && s !== '.');
}

/** The category folder name without the trailing slash CATEGORIES stores (e.g. `documents`). */
function categoryFolder(category: Category): string {
  return CATEGORIES[category].folder.replace(/\/+$/, '');
}

/**
 * SECURITY (#1929): the `owner` is request-supplied — it comes from the edited
 * routing tree the operator POSTs (`RoutingRules`/`defaultOwner`), and a box-user
 * id (`Owner = 'shared' | BoxUserId`, `BoxUserId = string`) is otherwise
 * unconstrained. It becomes the FIRST path segment of the target
 * (`<owner>/<category>/…`), so a malicious `owner` of `..`, `../../etc`, an
 * absolute prefix, or anything carrying a separator / NUL would build a poisoned
 * target that climbs out of `file-share/data/`. The apply-time jail
 * (`resolveShareTarget`/`joinUnderRoot` in hostExec.ts) already rejects such a
 * target, but we clamp the owner HERE — the same single-clean-segment barrier
 * #1919 added for local-template names — so a poisoned owner fails fast at the
 * boundary with a clear error and can never be threaded into a path at all
 * (defence in depth; the importer never even forms an escaping target).
 */
function assertOwnerSegment(owner: string): void {
  if (
    owner === '' ||
    owner === '.' ||
    owner === '..' ||
    owner.includes('/') ||
    owner.includes('\\') ||
    owner.includes('\0')
  ) {
    throw new Error(`disk-import: invalid owner segment: ${JSON.stringify(owner)}`);
  }
}

/**
 * Resolve the relative target path (under `file-share/data/`) for a file given
 * its resolved routing rule and category. Returns `null` for the `junk` category
 * (nothing is written). Owner prefixes the path (shared omits the segment); the
 * mode decides whether the source subtree below the rule's anchor is preserved
 * (`parallel`) or flattened to the basename (`merge`).
 *
 * @param relPath the file's path RELATIVE to the imported disk root
 * @param category the classified category
 * @param rule the file's `effectiveRule` (owner + mode + anchor)
 */
export function resolveTargetPath(
  relPath: string,
  category: Category,
  rule: Pick<ResolvedRule, 'owner' | 'mode' | 'anchor'>,
): string | null {
  const folder = categoryFolder(category);
  if (folder === '') return null; // junk — no destination folder.

  const fileSegs = relSegments(relPath);
  if (fileSegs.length === 0) return null; // nothing addressable.

  let tailSegs: string[];
  if (rule.mode === 'parallel') {
    // Preserve the source subtree BELOW the anchor (the dir that supplied the
    // rule). Drop the anchor prefix so the kept structure starts at the anchor.
    const anchorSegs = relSegments(rule.anchor);
    tailSegs = fileSegs.slice(anchorSegs.length);
    // A file sitting exactly at the anchor (no deeper subtree) still keeps its
    // own basename so it isn't dropped.
    if (tailSegs.length === 0) tailSegs = fileSegs.slice(-1);
  } else {
    // merge: flatten — everything lands directly in the category folder.
    tailSegs = fileSegs.slice(-1);
  }

  let ownerPrefix: string[];
  if (rule.owner === 'shared') {
    ownerPrefix = [];
  } else {
    // The owner is request-supplied — clamp it to a single clean segment before
    // it becomes the target's first path component (#1929 path-traversal guard).
    assertOwnerSegment(rule.owner);
    ownerPrefix = [rule.owner];
  }
  return [...ownerPrefix, folder, ...tailSegs].join('/');
}

// --- relative-dir helpers ---------------------------------------------------

/** The directory of a relative file path (`''` for a top-level file). */
export function dirOfRel(relPath: string): string {
  const trimmed = relPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash === -1 ? '' : trimmed.slice(0, slash);
}

// --- review tree (issue #1915) ---------------------------------------------
//
// The review UI needs a per-FOLDER picture of the source disk: every directory
// that holds files, its file/byte tally, the categories its files classify to,
// and the directory's resolved rule (so the card can show inherited-vs-explicit
// dispositions + owners and the `data/<owner>/<category>/…` target preview).
// This is derived purely from the (relative) source dirs + the explicit rule
// map — no I/O. The classify pass already ran in `buildPlan`; the caller passes
// each file's resolved relative dir + category so this helper just tallies.

/** One file's already-resolved coordinates for the tree tally. */
export interface TreeFileInput {
  /** Directory of the file, RELATIVE to the disk root (`''` = root). */
  dir: string;
  /** The category the engine classified the file into. */
  category: Category;
  /** File size in bytes. */
  size: number;
}

/** A directory node in the review tree. */
export interface FolderNode {
  /** Relative dir path (`''` = the disk root). */
  dir: string;
  /** Number of files directly in this dir (not counting subdirs). */
  files: number;
  /** Summed bytes of files directly in this dir. */
  bytes: number;
  /** Categories the dir's own files classify to (sorted, deduped). */
  categories: Category[];
  /** This dir's explicit rule (the axes the user set on THIS node), if any. */
  explicit: Rule;
  /** The fully-resolved effective rule (inherited where not explicit). */
  resolved: ResolvedRule;
}

/**
 * Build the per-folder review tree: one {@link FolderNode} per directory that
 * holds files (plus every ancestor on the path, so the tree is connected to the
 * root). Each node carries its file/byte tally, the categories its files map to,
 * its explicit rule, and its resolved effective rule. Sorted by dir for a stable
 * render. The root (`''`) is always present.
 *
 * @param files each file's relative dir + classified category + size
 * @param explicit the explicit rule map (auto-assigned + user edits)
 * @param rootDefault the root default (e.g. the disk-default owner)
 */
export function buildFolderTree(
  files: readonly TreeFileInput[],
  explicit: ReadonlyMap<string, Rule>,
  rootDefault: Partial<Rule> = {},
): FolderNode[] {
  const tally = new Map<string, { files: number; bytes: number; cats: Set<Category> }>();
  const dirs = new Set<string>(['']);

  const touch = (dir: string) => {
    if (!tally.has(dir)) tally.set(dir, { files: 0, bytes: 0, cats: new Set() });
    return tally.get(dir)!;
  };

  for (const f of files) {
    const t = touch(f.dir);
    t.files += 1;
    t.bytes += f.size;
    t.cats.add(f.category);
    // Register the dir and every ancestor so the tree stays connected.
    let cursor: string | null = f.dir;
    while (cursor !== null) {
      dirs.add(cursor);
      touch(cursor);
      cursor = parentDir(cursor);
    }
  }

  return [...dirs]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(dir => {
      const t = tally.get(dir)!;
      return {
        dir,
        files: t.files,
        bytes: t.bytes,
        categories: [...t.cats].sort((a, b) => (a < b ? -1 : 1)),
        explicit: explicit.get(dir) ?? {},
        resolved: effectiveRule(dir, explicit, rootDefault),
      };
    });
}
