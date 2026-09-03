// Disk-import launch tile (#1953) — typed helpers for the raw `fetch('/api/...')`
// call sites in `packages/frontend/.../disk-import/page.tsx` (sb/no-raw-api-fetch
// sweep). None of these routes go through `withApiHandler`'s auto `{ ok, data }`
// envelope — every disk-import route builds its own `NextResponse.json(...)` body
// directly (see `packages/frontend/src/app/api/system/disk-import/*/route.ts`), so
// every helper here goes through `rawApi`/`mutateRawApi`. Schemas are lenient
// (plain `z.string()` instead of a literal union, numeric fields `.catch(0)`,
// `.passthrough()`/`.catch()` on partially-read objects) so a legacy/partial row
// on a long-lived box degrades gracefully instead of failing the whole read.

import { z } from 'zod';
import { rawApi, mutateRawApi } from './client';

/** A folder's explicit (partial) routing rule. Structurally compatible with the
 *  frontend's own `Rule` type (`disk-import/_lib/types.ts`) without importing it
 *  — that type intentionally stays frontend-local to avoid pulling
 *  `@servicebay/disk-import-worker` (native deps) into the browser bundle. */
export interface DiskImportRuleInput {
  disposition?: string;
  mode?: string;
  owner?: string;
  base?: boolean;
}

const DiskImportRuleSchema = z
  .object({
    disposition: z.string().optional(),
    mode: z.string().optional(),
    owner: z.string().optional(),
    base: z.boolean().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// GET /api/system/disk-import/list-devices
// ---------------------------------------------------------------------------

export const DiskImportDeviceSchema = z.object({ path: z.string(), display: z.string() });
export type DiskImportDevice = z.infer<typeof DiskImportDeviceSchema>;

const ListDevicesResponseSchema = z.object({
  ok: z.literal(true),
  devices: z.array(DiskImportDeviceSchema).catch([]),
});

/** GET /api/system/disk-import/list-devices — the tile's device picker. */
export async function listImportDevices(): Promise<DiskImportDevice[]> {
  const data = await rawApi('/api/system/disk-import/list-devices', ListDevicesResponseSchema);
  return data.devices;
}

// ---------------------------------------------------------------------------
// GET /api/system/disk-import/status
// ---------------------------------------------------------------------------

export const DiskImportCategoryRollupSchema = z.object({
  category: z.string(),
  files: z.number().catch(0),
  bytes: z.number().catch(0),
  copy: z.number().catch(0),
  skipDupe: z.number().catch(0),
  conflict: z.number().catch(0),
  renamed: z.number().optional(),
});
export type DiskImportCategoryRollup = z.infer<typeof DiskImportCategoryRollupSchema>;

const DiskImportRunStatusDetailSchema = z.object({
  phase: z.string(),
  step: z.string(),
  // Only ever compared against the two known literals; `.catch` degrades an
  // unrecognized value to the harmless default instead of failing the poll.
  mode: z.enum(['dry-run', 'apply']).catch('dry-run'),
  scanned: z.number().catch(0),
  planned: z.number().catch(0),
  applied: z.number().catch(0),
  conflicts: z.number().catch(0),
  categories: z.array(DiskImportCategoryRollupSchema).optional(),
  totalBytes: z.number().optional(),
  error: z.string().nullable(),
});

const RunStatusResponseSchema = z.object({
  ok: z.literal(true),
  runId: z.string(),
  running: z.boolean(),
  status: DiskImportRunStatusDetailSchema.nullable(),
});
export type DiskImportRunStatus = z.infer<typeof RunStatusResponseSchema>;

/**
 * GET /api/system/disk-import/status — the active run's compact progress. The
 * route answers 404 for "no run has been launched" (an expected state, not a
 * failure) — callers branch on `TypedFetchError.status === 404` (from
 * `./client`, re-exported off the package index) to tell that apart from a
 * transient failure (#2457).
 */
export function fetchDiskImportStatus(): Promise<DiskImportRunStatus> {
  return rawApi('/api/system/disk-import/status', RunStatusResponseSchema);
}

// ---------------------------------------------------------------------------
// POST /api/system/disk-import/abort
// ---------------------------------------------------------------------------

const AbortResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

/** POST /api/system/disk-import/abort — "Start over". Idempotent. */
export async function abortDiskImport(): Promise<void> {
  await mutateRawApi('/api/system/disk-import/abort', AbortResponseSchema);
}

// ---------------------------------------------------------------------------
// GET/POST /api/system/disk-import/tree
// ---------------------------------------------------------------------------

const ReviewNodeSchema = z.object({
  dir: z.string(),
  files: z.number().catch(0),
  bytes: z.number().catch(0),
  categories: z.array(z.string()).catch([]),
  explicit: DiskImportRuleSchema,
  resolved: z
    .object({
      disposition: z.string(),
      mode: z.string(),
      owner: z.string(),
      anchor: z.string(),
    })
    .passthrough(),
  preview: z.string(),
});

const ReviewOwnerSchema = z.object({ id: z.string(), label: z.string() });

const ReviewTreeResponseSchema = z.object({
  ok: z.literal(true),
  tree: z.array(ReviewNodeSchema).catch([]),
  owners: z.array(ReviewOwnerSchema).catch([]),
  dispositions: z.array(z.string()).catch([]),
  mountBase: z.string(),
});
export type DiskImportReviewTree = z.infer<typeof ReviewTreeResponseSchema>;

/**
 * GET (no edits) / POST (`{ rules }`, re-resolves against the operator's
 * in-progress picks) /api/system/disk-import/tree — the per-folder review tree.
 * Matches the page's own `hasEdits` split: an empty rule map reads, a non-empty
 * one re-resolves.
 */
export function fetchDiskImportTree(
  rules?: Record<string, DiskImportRuleInput>,
): Promise<DiskImportReviewTree> {
  const hasEdits = rules !== undefined && Object.keys(rules).length > 0;
  return hasEdits
    ? mutateRawApi('/api/system/disk-import/tree', ReviewTreeResponseSchema, { rules })
    : rawApi('/api/system/disk-import/tree', ReviewTreeResponseSchema);
}

// ---------------------------------------------------------------------------
// GET/POST/DELETE /api/system/disk-import/profiles — saved routing presets
// ---------------------------------------------------------------------------

const DiskImportRoutingProfileSchema = z.object({
  name: z.string(),
  rules: z.record(z.string(), DiskImportRuleSchema).catch({}),
  rootDefault: DiskImportRuleSchema.optional(),
  savedAt: z.number().catch(0),
});
export type DiskImportRoutingProfile = z.infer<typeof DiskImportRoutingProfileSchema>;

const ListProfilesResponseSchema = z.object({
  ok: z.literal(true),
  profiles: z.array(DiskImportRoutingProfileSchema).catch([]),
});

/** GET /api/system/disk-import/profiles — saved routing presets, newest first. */
export async function listImportProfiles(): Promise<DiskImportRoutingProfile[]> {
  const data = await rawApi('/api/system/disk-import/profiles', ListProfilesResponseSchema);
  return data.profiles;
}

// The save/delete responses (`{ ok: true, profile }` / `{ ok: true }`) aren't read
// by any caller today — both reload the list right after — so the schema only
// pins the field that matters (`ok`) and passes the rest through untouched.
const ProfileMutationResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

/** POST /api/system/disk-import/profiles — save (create or overwrite) a preset. */
export async function saveImportProfile(
  name: string,
  rules: Record<string, DiskImportRuleInput>,
): Promise<void> {
  await mutateRawApi('/api/system/disk-import/profiles', ProfileMutationResponseSchema, { name, rules });
}

/** DELETE /api/system/disk-import/profiles?name=… — remove a preset (idempotent). */
export async function deleteImportProfile(name: string): Promise<void> {
  await mutateRawApi(
    `/api/system/disk-import/profiles?name=${encodeURIComponent(name)}`,
    ProfileMutationResponseSchema,
    undefined,
    'DELETE',
  );
}
