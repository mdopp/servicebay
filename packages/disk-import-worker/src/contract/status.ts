// Disk-import worker ↔ servicebay status-file contract (#1951, slice of #1949).
//
// THE CONTRACT. The worker runs the heavy walk/hash/classify/dedup/plan/apply in
// its OWN resource-capped container and writes its progress to a SHARED volume.
// servicebay launches + monitors the worker and reads ONLY these files — it never
// pulls the heavy data structures (the 269k-node inventory/plan that OOM'd the
// control plane in-process, see feedback_control_plane_vs_worker) into its own
// process.
//
// Two files, by design:
//   • status.json   — SMALL, frequently rewritten. Step/phase/counts/error only.
//                     servicebay polls this for liveness + progress. It MUST stay
//                     compact: NO inventory, NO plan items, NO file lists inline.
//   • plan.json     — the HEAVY sidecar (the full ImportPlan: every item +
//                     conflict). Written ONCE when planning completes. servicebay
//                     renders it lazily/summary-first, never as 269k DOM nodes.
//
// Both shapes live HERE, in one module, so the worker (writer) and servicebay
// (reader) cannot drift — the operator decision (2026-06-18) is that shared
// contracts stay in one place in one repo.

import type { ImportPlan, Category } from '../engine/types';

/** Canonical file names the worker writes into the shared out-volume. */
export const STATUS_FILE = 'status.json';
export const PLAN_SIDECAR_FILE = 'plan.json';

/** Schema version of the status/plan-sidecar contract. Bump on any breaking shape change. */
export const STATUS_CONTRACT_VERSION = 1 as const;

/**
 * The phase the worker is in. Linear, with two terminal states (`done`/`error`).
 *   scanning   — walking the mounted device (read-only) into a metadata list.
 *   planning   — inventory → classify → dedup (lazy hash) → plan.
 *   applying   — copying files into the shared out area (only on --apply).
 *   done        — finished successfully (plan written; on --apply, files copied).
 *   error       — aborted; see `error`.
 */
export type WorkerPhase = 'scanning' | 'planning' | 'applying' | 'done' | 'error';

/**
 * Compact per-category rollup for the status doc — counts/bytes only, never the
 * file records themselves. This is the summary servicebay shows while the heavy
 * plan sidecar is rendered lazily.
 */
export interface CategoryRollup {
  category: Category;
  files: number;
  bytes: number;
  copy: number;
  skipDupe: number;
  conflict: number;
}

/**
 * The compact status document. Small enough to rewrite on every progress tick
 * without I/O pressure. Holds NO inventory and NO plan items — only scalars and
 * the small per-category rollup. The heavy plan lives in the sidecar.
 */
export interface WorkerStatus {
  /** Contract schema version (=== STATUS_CONTRACT_VERSION when written by this worker). */
  version: typeof STATUS_CONTRACT_VERSION;
  /** Opaque id servicebay assigns the run (mirrors the session id). */
  runId: string;
  phase: WorkerPhase;
  /** Human-readable one-liner for the current step (e.g. "Scanning /mnt/src …"). */
  step: string;
  /** Mode the worker was launched in. */
  mode: 'dry-run' | 'apply';
  /** Files seen by the scan so far (grows during `scanning`). */
  scanned: number;
  /** Total planned items once `planning` completes (else 0). */
  planned: number;
  /** Files actually written this pass (grows during `applying`). */
  applied: number;
  /** Number of unresolved conflicts in the plan (review-gate signal). */
  conflicts: number;
  /** Per-category rollup — compact, computed once the plan exists. */
  categories: CategoryRollup[];
  /** Total bytes across all planned items. */
  totalBytes: number;
  /** Relative name of the plan sidecar (=== PLAN_SIDECAR_FILE) once written, else null. */
  planSidecar: string | null;
  /** Set only in `error` phase: the failure message. null otherwise. */
  error: string | null;
  /** Epoch ms of the last write — servicebay's liveness/staleness signal. */
  updatedAt: number;
  /** Epoch ms the worker started. */
  startedAt: number;
}

/**
 * The heavy sidecar: the full deterministic plan. Written ONCE when planning
 * completes. servicebay reads this lazily (paginated/summary-first), NEVER eagerly
 * into the status poll path.
 */
export interface PlanSidecar {
  version: typeof STATUS_CONTRACT_VERSION;
  runId: string;
  plan: ImportPlan;
}

/** Build the per-category rollup from a plan — compact, no records inline. */
export function summarizeCategories(plan: ImportPlan): CategoryRollup[] {
  const byCat = new Map<Category, CategoryRollup>();
  for (const item of plan.items) {
    const r =
      byCat.get(item.category) ??
      ({ category: item.category, files: 0, bytes: 0, copy: 0, skipDupe: 0, conflict: 0 } as CategoryRollup);
    r.files += 1;
    r.bytes += item.record.size;
    if (item.action === 'copy') r.copy += 1;
    else if (item.action === 'skip-dupe') r.skipDupe += 1;
    else if (item.action === 'conflict') r.conflict += 1;
    byCat.set(item.category, r);
  }
  return [...byCat.values()].sort((a, b) => a.category.localeCompare(b.category));
}

/** A fresh status doc at run start (phase `scanning`, all counts zero). */
export function initialStatus(runId: string, mode: 'dry-run' | 'apply', now: number = Date.now()): WorkerStatus {
  return {
    version: STATUS_CONTRACT_VERSION,
    runId,
    phase: 'scanning',
    step: 'Starting …',
    mode,
    scanned: 0,
    planned: 0,
    applied: 0,
    conflicts: 0,
    categories: [],
    totalBytes: 0,
    planSidecar: null,
    error: null,
    updatedAt: now,
    startedAt: now,
  };
}
