// Disk-import worker <-> servicebay contract — the RUNTIME schemas (#2747).
//
// `status.ts` next door declares the contract's TYPES; those vanish at runtime, so
// every crossing of the boundary was an unchecked `JSON.parse(...) as WorkerStatus`
// on servicebay's side and a hand-rolled partial re-declaration on the route's side.
// This module is the one place the three wire DOCUMENTS are described to zod:
//
//   status.json          -> workerStatusSchema   (the scan/apply progress result)
//   plan.json            -> planSidecarSchema    (the heavy plan the review renders)
//   replan-request.json  -> replanRequestSchema  (the apply/re-plan job servicebay
//                                                 writes for the worker to execute)
//
// It lives in the WORKER because the worker is the writer of two of the three and
// servicebay already imports this package directly (its engine, its catalog, its
// status constants) — a separate `@servicebay/…-contract` workspace package, the
// `packages/backup-manifest` shape from #2733, buys nothing here: that one existed
// to end a hand-maintained FORK of a file the sandboxed backup worker could not
// import, and there is no fork and no import ban to dissolve on this boundary.
//
// The schemas are kept structurally identical to the interfaces in `status.ts` /
// `engine/types.ts` by type-level equality assertions in the contract test
// (`packages/backend/src/lib/diskImport/contract.test.ts`), so adding a field to
// one side without the other is a TYPE error, not a runtime surprise.

import { z } from 'zod';

import { STATUS_CONTRACT_VERSION } from './status';

/** A file's canonical category (`junk` = skip). Mirrors `engine/types.Category`. */
const categorySchema = z.enum([
  'photos',
  'movies',
  'music',
  'audiobooks',
  'podcasts',
  'documents',
  'junk',
]);

/** One scanned file, metadata-only. `sha256` is filled in lazily by dedup. */
const importRecordSchema = z.object({
  sourcePath: z.string(),
  size: z.number(),
  mtimeMs: z.number(),
  ext: z.string(),
  name: z.string(),
  sha256: z.string().optional(),
});

/** What the plan decided to do with a record. */
const importActionSchema = z.enum(['copy', 'skip-junk', 'skip-dupe', 'conflict']);

/** One planned entry. `area`/`renamed` are absent on sidecars written pre-#2631/#2006. */
const importPlanItemSchema = z.object({
  record: importRecordSchema,
  category: categorySchema,
  target: z.string().nullable(),
  action: importActionSchema,
  area: z.string().optional(),
  renamed: z.boolean().optional(),
});

/** Two different files resolving to the same target — surfaced, never overwritten. */
const conflictSchema = z.object({
  target: z.string(),
  existing: z.object({ sourcePath: z.string(), sha256: z.string() }),
  incoming: z.object({ sourcePath: z.string(), sha256: z.string() }),
});

/** The deterministic plan itself. */
const importPlanSchema = z.object({
  items: z.array(importPlanItemSchema),
  conflicts: z.array(conflictSchema),
});

/** The worker's linear phase, with `done`/`error` terminal. */
const workerPhaseSchema = z.enum(['scanning', 'planning', 'applying', 'done', 'error']);

/** Compact per-category rollup carried inside the status doc. */
const categoryRollupSchema = z.object({
  category: categorySchema,
  files: z.number(),
  bytes: z.number(),
  copy: z.number(),
  skipDupe: z.number(),
  conflict: z.number(),
  renamed: z.number(),
});

/**
 * `status.json` — THE SCAN RESULT servicebay polls. Compact by contract: counts,
 * phase, step text and the small per-category rollup, never inventory or plan
 * items. Both the worker (`runWorker`/`runReplan`) and servicebay's host-apply
 * write this file, so both sides validate against this one schema.
 */
export const workerStatusSchema = z.object({
  version: z.literal(STATUS_CONTRACT_VERSION),
  runId: z.string(),
  phase: workerPhaseSchema,
  step: z.string(),
  mode: z.enum(['dry-run', 'apply']),
  scanned: z.number(),
  planned: z.number(),
  applied: z.number(),
  conflicts: z.number(),
  categories: z.array(categoryRollupSchema),
  totalBytes: z.number(),
  planSidecar: z.string().nullable(),
  error: z.string().nullable(),
  updatedAt: z.number(),
  startedAt: z.number(),
});

/**
 * `plan.json` — THE PLAN. Written once by the worker when planning completes (and
 * rewritten by a re-plan); read by servicebay's review tree and host-apply.
 */
export const planSidecarSchema = z.object({
  version: z.literal(STATUS_CONTRACT_VERSION),
  runId: z.string(),
  plan: importPlanSchema,
  mountBase: z.string(),
});

/** The WHAT axis of a routing rule, in stable presentation order. Pinned against
 *  `engine/types.DISPOSITIONS` by the contract test. */
export const dispositionSchema = z.enum([
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
]);

/**
 * A folder's explicit (partial) routing rule — every axis optional, each inherited
 * down the tree independently. `owner` is `shared` or a box-user id; the engine's
 * `assertOwnerSegment` is the path-traversal guard at apply time, this only pins
 * the shape.
 */
export const ruleSchema = z
  .object({
    disposition: dispositionSchema.optional(),
    mode: z.enum(['merge', 'parallel']).optional(),
    owner: z.string().optional(),
    base: z.boolean().optional(),
  })
  .strict();

/**
 * `replan-request.json` — THE APPLY/RE-PLAN JOB. servicebay writes this into the
 * worker container (`replanImport`) and the worker's `--replan` pass reads it, so
 * this is the one shape that travels servicebay -> worker rather than the other way.
 */
export const replanRequestSchema = z
  .object({
    explicit: z.record(z.string(), ruleSchema),
    rootDefault: ruleSchema.optional(),
  })
  .strict();
