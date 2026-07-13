// Lazy, summary-first routing tree (#1953, slice of #1949).
//
// THE REVIEW UX FIX. A 269k-file disk produces a 269k-node tree; rendering it
// whole OOM'd the browser and was unusable (feedback_control_plane_vs_worker).
// Instead the worker frontend renders the tree LAZILY: it asks for one
// directory's IMMEDIATE children at a time, each child carrying a recursive
// rollup (file/byte/category counts for its whole subtree) so a collapsed node
// already shows "what's in here" without expanding it. Children are fetched on
// expand — the tree never materialises whole, in the worker OR the browser.
//
// This derives purely from the heavy plan sidecar the worker already wrote
// (PlanSidecar.plan.items). The worker reads the sidecar ONCE per request and
// returns only the small child slice; the compact status.json is untouched.

import { normPath } from '../engine/pathNorm';
import type { Category, ImportPlan } from '../engine/types';

/**
 * One node in the lazy tree: a single directory, with a RECURSIVE rollup of its
 * whole subtree (so a collapsed node is still informative) and a `hasChildren`
 * flag the UI uses to show an expand affordance without fetching a level early.
 */
export interface LazyTreeNode {
  /** Directory path relative to the disk root (`''` = the root). */
  dir: string;
  /** Last path segment for display (`''` for the root). */
  name: string;
  /** Files directly in this dir (not its subdirs). */
  directFiles: number;
  /** Files in this dir AND every descendant (the collapsed-node rollup). */
  totalFiles: number;
  /** Bytes across this dir and every descendant. */
  totalBytes: number;
  /** Categories anywhere in this subtree (sorted, deduped). */
  categories: Category[];
  /** True when the dir has at least one immediate subdirectory to expand into. */
  hasChildren: boolean;
}

/** The immediate children of one directory — the unit a lazy fetch returns. */
export interface LazyTreeLevel {
  /** The parent dir these children belong to (`''` = root level). */
  parent: string;
  /** The total number of planned files on the whole disk (root-level context). */
  totalFiles: number;
  /** This dir's immediate child directories, each with a subtree rollup. */
  children: LazyTreeNode[];
}

/** Normalise a relative path (strip leading/trailing slashes, backslashes). */
function normDir(rel: string): string {
  return normPath(rel, { backslashToSlash: true });
}

/** The directory of a relative file path (`''` for a root-level file). */
function dirOf(rel: string): string {
  const t = normDir(rel);
  const slash = t.lastIndexOf('/');
  return slash === -1 ? '' : t.slice(0, slash);
}

/**
 * The immediate child segment of `dir` on the path to `descendantDir`, or null
 * when `descendantDir` is not strictly under `dir`. `dir=''` (root) returns the
 * first segment of any non-root descendant.
 */
function childUnder(dir: string, descendantDir: string): string | null {
  const parent = normDir(dir);
  const desc = normDir(descendantDir);
  if (parent === desc) return null;
  if (parent === '') return desc === '' ? null : desc.split('/')[0];
  if (!desc.startsWith(parent + '/')) return null;
  return desc.slice(parent.length + 1).split('/')[0];
}

interface Rollup {
  totalFiles: number;
  totalBytes: number;
  directFiles: number;
  cats: Set<Category>;
  hasChildren: boolean;
}

/**
 * Compute the immediate children of `parent` from a plan, each with a recursive
 * subtree rollup. Single pass over the plan items (no full-tree materialisation):
 * for every planned file we find which immediate child of `parent` it lives
 * under (if any) and fold its size/category into that child's rollup. Junk items
 * (`target === null`) are excluded — they aren't imported, so they don't appear
 * in the review tree.
 *
 * @param mountBase the scan mountpoint (e.g. `/mnt/src`) the records' absolute
 *   source paths are made relative to. Defaults to `''` (paths already relative).
 */
export function lazyChildren(plan: ImportPlan, parent: string, mountBase = ''): LazyTreeLevel {
  const norm = normDir(parent);
  // Trim only a trailing slash from the base — keep its leading slash so an
  // absolute source path matches it (normDir would strip the leading slash).
  const base = normPath(mountBase, { backslashToSlash: true, stripLeading: false });
  const rel = (sourcePath: string): string =>
    base && sourcePath.startsWith(base + '/') ? sourcePath.slice(base.length + 1) : normDir(sourcePath);

  const byChild = new Map<string, Rollup>();
  let totalFiles = 0;

  for (const item of plan.items) {
    if (item.target === null) continue; // junk: never in the tree
    const fileDir = dirOf(rel(item.record.sourcePath));
    totalFiles += 1;
    const child = childUnder(norm, fileDir);
    // child === null → the file is directly in `parent` itself (or unrelated):
    // it contributes no child node at this level.
    if (child === null) {
      if (fileDir === norm) bumpDirect(byChild, norm);
      continue;
    }
    const childDir = norm === '' ? child : `${norm}/${child}`;
    const r = ensureRollup(byChild, childDir);
    r.totalFiles += 1;
    r.totalBytes += item.record.size;
    r.cats.add(item.category);
    if (fileDir === childDir) r.directFiles += 1;
    else r.hasChildren = true; // file lives strictly below the child
  }

  const children: LazyTreeNode[] = [...byChild.entries()]
    .filter(([dir]) => dir !== norm) // drop the parent's own direct-file tally row
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, r]) => ({
      dir,
      name: dir.split('/').pop() ?? dir,
      directFiles: r.directFiles,
      totalFiles: r.totalFiles,
      totalBytes: r.totalBytes,
      categories: [...r.cats].sort((a, b) => (a < b ? -1 : 1)),
      hasChildren: r.hasChildren,
    }));

  return { parent: norm, totalFiles, children };
}

function ensureRollup(map: Map<string, Rollup>, dir: string): Rollup {
  let r = map.get(dir);
  if (!r) {
    r = { totalFiles: 0, totalBytes: 0, directFiles: 0, cats: new Set(), hasChildren: false };
    map.set(dir, r);
  }
  return r;
}

function bumpDirect(map: Map<string, Rollup>, dir: string): void {
  ensureRollup(map, dir).directFiles += 1;
}
