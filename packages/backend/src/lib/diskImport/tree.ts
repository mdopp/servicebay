// Disk-import — review-tree builder for the routing UI (#1915 / epic #1901).
//
// Turns the worker's compact `plan.json` (which servicebay already reads for the
// host-apply) into the per-folder review tree the importer page renders: one
// FolderNode per directory with file/byte/category rollups, the auto-assigned
// owner (top-level folder name == a box user), and the resolved effective rule.
// NO worker change + NO re-scan: the plan sidecar already has every file's
// source path + category + size, so the tree is derived host-side here.
//
// The user then edits owner + disposition per folder; those edits flow back to
// the apply call as an explicit rule map and re-plan the import with routing
// (see service.applyRun → applyImport, which threads a RoutingResolution).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildFolderTree,
  autoAssignOwners,
  ROOT_DEFAULT,
  PLAN_SIDECAR_FILE,
  DISPOSITIONS,
  type PlanSidecar,
  type FolderNode,
  type TreeFileInput,
  type Rule,
  type Owner,
  type Disposition,
} from '@servicebay/disk-import-worker';

import { listLldapUsers } from '@/lib/lldap/client';
import { runOutDir } from './apply';

/** An owner choice for the picker: `shared` plus each box user. */
export interface ReviewOwner {
  /** The owner id used in `data/<owner>/…` and rules (`shared` or a username). */
  id: Owner;
  /** Human label for the dropdown. */
  label: string;
}

export interface ReviewTree {
  /** Every folder that holds files (+ ancestors), with rollups + resolved rule. */
  tree: FolderNode[];
  /** Owner picker options: `shared` first, then box users. */
  owners: ReviewOwner[];
  /** Disposition (target) picker options, in presentation order. */
  dispositions: readonly Disposition[];
  /** The worker mountBase the source paths are relative to. */
  mountBase: string;
}

/** Relative dir of a source path under the worker mountBase (`''` = root). */
export function relDirOf(sourcePath: string, mountBase: string): string {
  const base = mountBase.replace(/\/+$/, '');
  const rel =
    sourcePath === base
      ? ''
      : sourcePath.startsWith(`${base}/`)
        ? sourcePath.slice(base.length + 1)
        : sourcePath;
  const dir = path.posix.dirname(rel);
  return dir === '.' || dir === '/' ? '' : dir;
}

async function loadSidecar(runId: string): Promise<PlanSidecar> {
  const raw = await readFile(path.join(runOutDir(runId), PLAN_SIDECAR_FILE), 'utf8');
  return JSON.parse(raw) as PlanSidecar;
}

/**
 * Build the review tree for a completed scan. `explicit` carries the user's
 * in-progress edits (relDir → partial Rule) so the resolved rules reflect them;
 * empty on first load (only the exact-match owner auto-assign applies).
 */
export async function buildReviewTree(
  runId: string,
  opts: { diskDefaultOwner?: Owner; explicit?: Map<string, Rule> } = {},
): Promise<ReviewTree> {
  const sidecar = await loadSidecar(runId);

  // Every planned file → its folder coordinate (junk included so the tree shows
  // the whole disk; the user can mark a junk-heavy folder skip/archive).
  const files: TreeFileInput[] = sidecar.plan.items.map(i => ({
    dir: relDirOf(i.record.sourcePath, sidecar.mountBase),
    category: i.category,
    size: i.record.size,
  }));

  const usersRes = await listLldapUsers();
  const users = usersRes.ok ? usersRes.users : [];
  const owners: ReviewOwner[] = [
    { id: 'shared', label: 'Shared' },
    ...users.map(u => ({ id: u.id, label: u.displayName || u.id })),
  ];

  // Exact-match auto-assign: a top-level folder named like a box user is seeded
  // to that owner (overridable). Merge the user's in-progress edits on top.
  const topLevel = new Set<string>();
  for (const f of files) {
    const seg = f.dir.split('/')[0];
    if (seg) topLevel.add(seg);
  }
  const explicit = autoAssignOwners(
    [...topLevel],
    users.map(u => u.id),
    opts.explicit ?? new Map(),
  );

  const rootDefault: Partial<Rule> = { owner: opts.diskDefaultOwner ?? ROOT_DEFAULT.owner };
  const tree = buildFolderTree(files, explicit, rootDefault);

  return { tree, owners, dispositions: DISPOSITIONS, mountBase: sidecar.mountBase };
}
