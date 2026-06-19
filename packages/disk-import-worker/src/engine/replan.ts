// disk-import-worker — RE-PLAN with the per-folder routing rules (#2000 / epic
// #1901, the routing-tree review UI).
//
// THE ARCHITECTURAL FINDING (issue #2000): making the operator's per-folder owner
// + disposition picks actually route requires RE-PLANNING with the routing rules
// AND re-deduping PER OWNER. A naive "rewrite the copy targets to `<owner>/…` on
// the existing flat plan" is WRONG: the first plan deduped in the single `shared`
// scope, so a file that's a cross-owner duplicate was marked `skip-dupe` and the
// 2nd owner would never get it. The dedup area follows the resolved owner, so a
// re-plan splits the conflicts per person and lets the same bytes land in two
// owners' areas. Re-dedup needs CONTENT HASHING, and ONLY the worker can hash:
// the source disk is bind-mounted read-only at `mountBase` (`/mnt/src`) HERE, but
// NOT in servicebay's control-plane container (#1983). So the re-plan runs in the
// worker, over the already-scanned records (no re-walk) + the live mount.
//
// The records come straight from the existing `plan.json` sidecar (every item
// already carries its full `ImportRecord` — sourcePath + size + mtime + ext),
// so re-planning never re-scans the disk; it only re-classifies/re-dedups/re-routes
// with the routing tree and rewrites the sidecar + the compact status rollup.
// servicebay's host-apply then applies the rewritten `plan.json` UNCHANGED.

import path from 'node:path';

import { buildPlan, type HashResolver, type RoutingResolution } from './dedup';
import { effectiveRule } from './routing';
import type { ImportPlan, ImportRecord, Rule } from './types';
import {
  PLAN_SIDECAR_FILE,
  STATUS_FILE,
  STATUS_CONTRACT_VERSION,
  summarizeCategories,
  type PlanSidecar,
  type WorkerStatus,
} from '../contract/status';

/**
 * The re-plan request the page produces: the explicit (auto-assigned + edited)
 * routing rules keyed by source-relative directory, plus the disk-default owner
 * (the root-level default applied where no folder sets an owner). This is the wire
 * shape servicebay writes to `replan-request.json` in the shared out dir and the
 * body of `POST /api/replan`.
 */
export interface ReplanRequest {
  /** relDir → the (partial) Rule the operator set on that folder (`''` = root). */
  explicit: Record<string, Rule>;
  /** The disk-default owner / root default (e.g. `{ owner: 'mdopp' }`). */
  rootDefault?: Partial<Rule>;
}

/** IO seams so the re-plan is unit-testable without a real filesystem. */
export interface ReplanIO {
  /** Read + parse a JSON file under the out dir; null when absent/unparseable. */
  readJson: <T>(file: string) => Promise<T | null>;
  /** Persist the heavy plan sidecar (atomic-ish). */
  writePlanSidecar: (sidecar: PlanSidecar) => Promise<void>;
  /** Persist the compact status doc (atomic-ish). */
  writeStatus: (status: WorkerStatus) => Promise<void>;
  /** FULL content hash (sha256) of a record's bytes — reads via the live mount. */
  hashOf: HashResolver;
  /** Cheap content FINGERPRINT (head/middle/tail + size) — the dedup identity. */
  fingerprintOf: HashResolver;
  /** Clock for deterministic dates/tests. */
  now?: () => number;
}

/**
 * Strip trailing `/` without a backtracking `/\/+$/` regex (ReDoS-safe — the
 * CodeQL `js/polynomial-redos` rule flags the `+$` form; this is linear).
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end -= 1;
  return s.slice(0, end);
}

/** The relative dir of a source path under `mountBase` (`''` = the disk root). */
export function relPathUnder(sourcePath: string, mountBase: string): string {
  const base = stripTrailingSlashes(mountBase);
  if (sourcePath === base) return '';
  if (sourcePath.startsWith(`${base}/`)) return sourcePath.slice(base.length + 1);
  return sourcePath; // not under the base (defensive) — route by its own path.
}

/**
 * Turn the wire request's plain object rule map into the engine's `Map` and a
 * {@link RoutingResolution} over the plan's records. `relPathOf` strips the worker
 * `mountBase` so the routing tree's folder coordinates match the page's relDirs.
 */
export function toRoutingResolution(req: ReplanRequest, mountBase: string): RoutingResolution {
  const explicit = new Map<string, Rule>(Object.entries(req.explicit ?? {}));
  return {
    relPathOf: (record: ImportRecord) => relPathUnder(record.sourcePath, mountBase),
    explicit,
    rootDefault: req.rootDefault ?? {},
  };
}

/**
 * Re-run the deterministic plan over the already-scanned records with the routing
 * tree applied (per-owner dedup + owner-aware targets + forced dispositions), then
 * rewrite the plan sidecar and the compact status rollup. Returns the new plan.
 *
 * Reads the records from the EXISTING `plan.json` (no re-scan); hashes via the
 * injected resolvers (which read the live read-only mount). Idempotent: re-planning
 * with the same request yields the same plan.
 *
 * @throws if there is no plan sidecar yet (a re-plan before a scan completed).
 */
export async function runReplan(req: ReplanRequest, io: ReplanIO): Promise<ImportPlan> {
  const sidecar = await io.readJson<PlanSidecar>(PLAN_SIDECAR_FILE);
  if (!sidecar) throw new Error('disk-import: no plan to re-plan — scan first');

  const records: ImportRecord[] = sidecar.plan.items.map(i => i.record);
  const routing = toRoutingResolution(req, sidecar.mountBase);

  const nowFn = io.now ?? Date.now;
  // Carry the scan's status forward (scanned count, startedAt) so the rollup stays
  // coherent; fall back defensively if none was written yet.
  const base = (await io.readJson<WorkerStatus>(STATUS_FILE)) ?? freshStatus(sidecar.runId, nowFn());

  // In-flight signal (#2009): the re-plan now runs DETACHED and servicebay/the page
  // poll status.json for completion. Scan-done and replan-done are BOTH `phase:done`,
  // so without flipping to an in-flight phase here a poller can't tell a launched
  // re-plan from the prior scan result. Write `planning` first, then progress while
  // the (multi-minute) re-dedup hashes, then `done` at the end.
  await io.writeStatus({
    ...base,
    phase: 'planning',
    mode: 'dry-run',
    step: 'Re-planning …',
    error: null,
    updatedAt: nowFn(),
  });

  const plan = buildPlan(records, io.hashOf, {
    routing,
    fingerprintOf: io.fingerprintOf,
    onProgress: (done, total) =>
      void io.writeStatus({
        ...base,
        phase: 'planning',
        mode: 'dry-run',
        step: `Re-planning … hashed ${done}/${total}`,
        error: null,
        updatedAt: nowFn(),
      }),
  });

  const newSidecar: PlanSidecar = {
    version: STATUS_CONTRACT_VERSION,
    runId: sidecar.runId,
    plan,
    mountBase: sidecar.mountBase,
  };
  await io.writePlanSidecar(newSidecar);

  // Refresh the compact status rollup so the tile poll reflects the re-plan
  // (new per-category copy/skip/conflict/renamed counts). `done` marks it ready
  // for the host-apply.
  const now = nowFn();
  const totalBytes = plan.items.reduce((sum, i) => sum + i.record.size, 0);
  const status: WorkerStatus = {
    ...base,
    phase: 'done',
    mode: 'dry-run',
    step: `Re-planned: ${plan.items.length} items, ${plan.conflicts.length} conflict(s).`,
    planned: plan.items.length,
    conflicts: plan.conflicts.length,
    categories: summarizeCategories(plan),
    totalBytes,
    planSidecar: PLAN_SIDECAR_FILE,
    error: null,
    updatedAt: now,
  };
  await io.writeStatus(status);

  return plan;
}

/** A minimal status doc when none exists yet (the worker always writes one first
 *  during the scan, so this is only a defensive fallback). */
function freshStatus(runId: string, now: number): WorkerStatus {
  return {
    version: STATUS_CONTRACT_VERSION,
    runId,
    phase: 'planning',
    step: 'Re-planning …',
    mode: 'dry-run',
    scanned: 0,
    planned: 0,
    applied: 0,
    conflicts: 0,
    categories: [],
    totalBytes: 0,
    planSidecar: PLAN_SIDECAR_FILE,
    error: null,
    updatedAt: now,
    startedAt: now,
  };
}

/** Re-export so callers needn't reach into routing.ts for a target preview. */
export { effectiveRule };

/** The canonical file name servicebay writes the re-plan request to (shared out). */
export const REPLAN_REQUEST_FILE = 'replan-request.json';

/** Resolve the request file path under an out dir (worker CLI + servicebay share). */
export function replanRequestPath(outDir: string): string {
  return path.join(outDir, REPLAN_REQUEST_FILE);
}
