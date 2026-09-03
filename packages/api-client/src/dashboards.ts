// Dashboard-region contracts — sb/no-raw-api-fetch sweep (#2745 follow-up).
//
// Backs the raw `fetch('/api/...')` call sites in
// `packages/frontend/src/dashboards/{Health,Network,Services,Overview,
// Containers}Dashboard.tsx`. Every route here predates the api-client
// migration and shapes its own `NextResponse.json(...)` body directly — none
// of them are wrapped in `withApiHandler`'s `{ ok, data }` envelope except
// where noted, so most methods go through `rawApi`/`mutateRawApi`. Schemas
// are deliberately lenient (`.passthrough()` / optional fields) wherever the
// calling dashboard only reads a subset of the body or discards it after
// checking `res.ok`.

import { z } from 'zod';
import { mutateApi, rawApi, mutateRawApi } from './client';
import type { Check, StackManifest } from './lib-types';

// ---------------------------------------------------------------------------
// Health checks — GET/POST /api/health/checks, DELETE ?id=, /:id/run, /:id/history
// ---------------------------------------------------------------------------

// Mirrors `CheckType` (packages/backend/src/lib/health/types.ts) — kept in
// sync by hand since the enum is not itself exported as a zod schema there.
const CheckTypeSchema = z.enum([
  'http',
  'ping',
  'podman',
  'service',
  'systemd',
  'fritzbox',
  'node',
  'agent',
  'backup',
  'domain',
  'letsdebug',
  'lan_ip_drift',
  'npm_auth',
  'cert_expiry',
  'cert_request_failure',
  'nginx_config_valid',
  'dns_routing',
  'diagnose',
]);

const HistoryEntrySchema = z
  .object({
    status: z.enum(['ok', 'fail']),
    latency: z.number(),
    timestamp: z.string(),
  })
  .passthrough();

const DiagnoseCheckPayloadSchema = z
  .object({
    status: z.enum(['ok', 'warn', 'fail', 'info']),
    label: z.string().optional(),
    detail: z.string().optional(),
    hint: z.string().optional(),
    actions: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
  })
  .passthrough();

/** One enriched row from GET /api/health/checks — a stored check plus its
 *  last-result status/history, or a synthetic `diagnose:*` probe row.
 *  Mirrors the backend's `Check` type (extends `CheckConfig`) field for
 *  field — the Checks table/history drawer read most of these, so this is
 *  the one schema in this module that is NOT lenient on the known fields. */
export const HealthCheckRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: CheckTypeSchema,
    target: z.string(),
    interval: z.number(),
    enabled: z.boolean(),
    created_at: z.string(),
    nodeName: z.string().optional(),
    failureThreshold: z.number().optional(),
    systemCheck: z.boolean().optional(),
    httpConfig: z
      .object({
        expectedStatus: z.number().optional(),
        bodyMatch: z.string().optional(),
        bodyMatchType: z.enum(['contains', 'regex']).optional(),
      })
      .passthrough()
      .optional(),
    fritzboxConfig: z
      .object({
        host: z.string().optional(),
        user: z.string().optional(),
        password: z.string().optional(),
      })
      .passthrough()
      .optional(),
    domainConfig: z
      .object({
        expectedScheme: z.enum(['http', 'https']),
        isPublic: z.boolean(),
        upstreamPort: z.number().optional(),
      })
      .passthrough()
      .optional(),
    status: z.enum(['ok', 'fail', 'unknown']),
    lastRun: z.string().nullable(),
    lastResult: z.string().nullable(),
    pending: z.boolean().optional(),
    message: z.string().optional(),
    history: z.array(HistoryEntrySchema),
    diagnose: DiagnoseCheckPayloadSchema.optional(),
    boxWide: z.boolean().optional(),
    serviceName: z.string().optional(),
  })
  .passthrough();
export type HealthCheckRow = z.infer<typeof HealthCheckRowSchema>;

/** GET /api/health/checks — raw seam (the route returns the array directly).
 *  Typed `Check[]` (not just `HealthCheckRow[]`) so it drops straight into
 *  the dashboards' existing `Check`-typed state — see the field-for-field
 *  schema above. */
export function getHealthChecks(): Promise<Check[]> {
  return rawApi('/api/health/checks', z.array(HealthCheckRowSchema));
}

/** POST /api/health/checks — create/update. Goes through `withApiHandler`
 *  (the handler returns the saved check as a plain value), so this is the
 *  ONE enveloped call in this module. Every caller only checks success and
 *  re-fetches the list afterward, so the payload is left untyped. */
const SavedCheckSchema = z.object({}).passthrough();
export function saveHealthCheck(body: unknown) {
  return mutateApi('/api/health/checks', SavedCheckSchema, body);
}

/** DELETE /api/health/checks?id= — also `withApiHandler`-wrapped on success
 *  (`{ success: true }`); the two named-error branches (diagnose row /
 *  not-found) already reply `{ ok: false, error, code }` themselves, which
 *  is exactly the shape `callApi`'s error path expects. */
const DeleteCheckResultSchema = z.object({ success: z.boolean() }).passthrough();
export function deleteHealthCheck(id: string) {
  return mutateApi(`/api/health/checks?id=${encodeURIComponent(id)}`, DeleteCheckResultSchema, undefined, 'DELETE');
}

/** POST /api/health/checks/:id/run — raw seam. The runner's result carries
 *  `status`/`message`/`latency` (the same shape whether it's a normal probe
 *  run or a re-run of a synthetic diagnose row). */
const CheckRunResultSchema = z
  .object({
    status: z.string().optional(),
    message: z.string().optional(),
    latency: z.number().optional(),
  })
  .passthrough();
export function runHealthCheck(id: string) {
  return mutateRawApi(`/api/health/checks/${encodeURIComponent(id)}/run`, CheckRunResultSchema);
}

/** GET /api/health/checks/:id/history — raw seam, an array of result rows.
 *  Matches HealthDashboard's local `HistoryItem` (status/latency/timestamp
 *  required, message optional) — the history drawer table renders all three. */
const CheckHistoryRowSchema = z
  .object({
    status: z.enum(['ok', 'fail']),
    latency: z.number(),
    timestamp: z.string(),
    message: z.string().optional(),
  })
  .passthrough();
export function getHealthCheckHistory(id: string) {
  return rawApi(`/api/health/checks/${encodeURIComponent(id)}/history`, z.array(CheckHistoryRowSchema));
}

// ---------------------------------------------------------------------------
// Node resources — the Health "add check" modal's container/service picker
// ---------------------------------------------------------------------------

/** GET /api/containers?node= — the route hands back `agent.sendCommand('listContainers')`
 *  verbatim, and the V4 agent already normalises `podman ps` into the
 *  camelCase `EnrichedContainer` shape (`packages/backend/src/lib/agent/types.ts`,
 *  built in `agent/v4/agent.py`'s `fetch_containers`): **lowercase**
 *  `id`/`names`/`image`, not podman's raw `Id`/`Names`/`Image` (#2782 — the
 *  capitalized guess made every call throw a `TypedFetchError`, so the health
 *  picker was always empty). Only the three fields the picker reads are
 *  declared; the rest of `EnrichedContainer` rides through `.passthrough()`. */
const NodeContainerSchema = z
  .object({
    id: z.string(),
    names: z.array(z.string()).optional(),
    image: z.string().optional(),
  })
  .passthrough();
export type NodeContainer = z.infer<typeof NodeContainerSchema>;

/** Lenient list read: one odd row (an id-less record, a future shape) must not
 *  empty the whole picker, so rows are parsed individually and the
 *  unparseable ones are dropped rather than failing the array. A non-array
 *  body still throws — that is a real route break. */
const NodeContainerListSchema = z.array(z.unknown()).transform(rows =>
  rows.flatMap(row => {
    const parsed = NodeContainerSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  }),
);

export function getNodeContainers(node: string) {
  return rawApi(`/api/containers?node=${encodeURIComponent(node)}`, NodeContainerListSchema);
}

/** GET /api/services?node= — the full service-view-model list for that node
 *  (same route as `getExternalLinks`, different query — a very different
 *  response shape). The resource picker only reads `.name`. */
const NamedServiceSchema = z.object({ name: z.string() }).passthrough();
export function getNodeServices(node: string) {
  return rawApi(`/api/services?node=${encodeURIComponent(node)}`, z.array(NamedServiceSchema));
}

/** GET /api/system/services?node= — raw systemd unit list; the picker reads `.unit`. */
const SystemServiceSchema = z.object({ unit: z.string() }).passthrough();
export function getNodeSystemServices(node: string) {
  return rawApi(`/api/system/services?node=${encodeURIComponent(node)}`, z.array(SystemServiceSchema));
}

// ---------------------------------------------------------------------------
// Network edges (manual connections) — POST/DELETE /api/network/edges
// ---------------------------------------------------------------------------

const NetworkEdgeSchema = z
  .object({
    id: z.string().optional(),
    source: z.string().optional(),
    target: z.string().optional(),
    label: z.string().optional(),
    port: z.number().optional(),
    created_at: z.string().optional(),
  })
  .passthrough();

/** POST /api/network/edges — raw seam; the caller discards the created edge
 *  and re-fetches the graph. */
export function createNetworkEdge(body: { source: string; target: string; type: 'manual'; port?: string }) {
  return mutateRawApi('/api/network/edges', NetworkEdgeSchema, body);
}

const DeleteEdgeResultSchema = z.object({ success: z.boolean() }).passthrough();
/** DELETE /api/network/edges?id= — raw seam. */
export function deleteNetworkEdge(id: string) {
  return mutateRawApi(`/api/network/edges?id=${encodeURIComponent(id)}`, DeleteEdgeResultSchema, undefined, 'DELETE');
}

// ---------------------------------------------------------------------------
// External links — GET /api/services?scope=links, POST /api/services,
// PUT /api/services/:name
// ---------------------------------------------------------------------------

const ApiLinkPortSchema = z
  .object({
    host: z.union([z.string(), z.number()]).optional(),
    hostPort: z.union([z.string(), z.number()]).optional(),
    container: z.union([z.string(), z.number()]).optional(),
    containerPort: z.union([z.string(), z.number()]).optional(),
    hostIp: z.string().optional(),
    protocol: z.string().optional(),
    source: z.string().optional(),
  })
  .passthrough();

const ApiLinkVolumeSchema = z
  .object({
    host: z.string().optional(),
    container: z.string().optional(),
  })
  .passthrough();

/** One row of GET /api/services?scope=links — mirrors `ApiLinkPayload` in
 *  `dashboards/_lib/servicesDashboard.ts` (kept in sync by hand; that type
 *  is the frontend's own mapping target, this is the wire contract). */
export const ApiLinkPayloadSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    nodeName: z.string().optional(),
    description: z.string().optional(),
    active: z.boolean().optional(),
    status: z.string().optional(),
    activeState: z.string().optional(),
    subState: z.string().optional(),
    kubePath: z.string().optional(),
    yamlPath: z.string().nullable().optional(),
    type: z.string().optional(),
    ports: z.array(ApiLinkPortSchema).optional(),
    volumes: z.array(ApiLinkVolumeSchema).optional(),
    monitor: z.boolean().optional(),
    url: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    verifiedDomains: z.array(z.string()).optional(),
    ipTargets: z.array(z.string()).optional(),
  })
  .passthrough();

/** GET /api/services?scope=links — raw seam. */
export function getExternalLinks() {
  return rawApi('/api/services?scope=links', z.array(ApiLinkPayloadSchema));
}

export interface ExternalLinkWritePayload {
  name: string;
  url: string;
  description?: string;
  monitor?: boolean;
  ipTargets?: string[];
  type: 'link';
}

const SuccessResultSchema = z.object({ success: z.boolean() }).passthrough();

/** POST /api/services (link-creation branch) — raw seam. */
export function createExternalLink(payload: ExternalLinkWritePayload) {
  return mutateRawApi('/api/services', SuccessResultSchema, payload);
}

/** PUT /api/services/:name (link-update branch, and "promote virtual node to
 *  link") — raw seam. `name` is the link's CURRENT name/id, matched against
 *  `body.name`/`body.url` inside the route for a rename. */
export function updateExternalLink(name: string, payload: Omit<ExternalLinkWritePayload, 'name'> & { name?: string }) {
  return mutateRawApi(`/api/services/${encodeURIComponent(name)}`, SuccessResultSchema, payload, 'PUT');
}

// ---------------------------------------------------------------------------
// Stacks — GET /api/system/stacks
// ---------------------------------------------------------------------------

const StackSummarySchema = z
  .object({
    name: z.string(),
    manifest: z.record(z.string(), z.unknown()).nullable().optional(),
    health: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

const StacksResponseSchema = z.object({ stacks: z.array(StackSummarySchema) }).passthrough();

/** One row of GET /api/system/stacks' `stacks` array, with `manifest` typed
 *  as the real `StackManifest` shape (zod validates it loosely at runtime —
 *  the manifest's own parser is the source of truth for its shape — but
 *  callers get the precise type). */
export interface StackSummary {
  name: string;
  manifest: StackManifest | null;
  health: Record<string, unknown> | null;
}

/** GET /api/system/stacks — raw seam. Shared by ServicesDashboard's stack
 *  grouping and ContainersDashboard's mirror of it (#2095). */
export function getStacks(): Promise<{ stacks: StackSummary[] }> {
  return rawApi('/api/system/stacks', StacksResponseSchema) as Promise<{ stacks: StackSummary[] }>;
}

// ---------------------------------------------------------------------------
// Unmanaged-bundle discovery — POST /api/system/discovery/dismiss
// ---------------------------------------------------------------------------

const DismissBundleResultSchema = z
  .object({
    success: z.boolean(),
    stoppedUnits: z.array(z.string()).optional(),
    removedFiles: z.array(z.string()).optional(),
    missingFiles: z.array(z.string()).optional(),
  })
  .passthrough();

/** POST /api/system/discovery/dismiss — raw seam. */
export function dismissUnmanagedBundle(bundleId: string, nodeName?: string) {
  return mutateRawApi('/api/system/discovery/dismiss', DismissBundleResultSchema, { bundleId, nodeName });
}

// ---------------------------------------------------------------------------
// ServiceBay self-update status — GET /api/system/update
// ---------------------------------------------------------------------------

/** GET /api/system/update — raw seam. Home's "last updated" freshness card
 *  only reads `config.autoUpdate.appliedImageUpdatedAt`; the rest of the
 *  updater status/config round-trip is left loose for the other consumer
 *  (the settings Updates section, migrated separately). */
const SystemUpdateStatusSchema = z
  .object({
    hasUpdate: z.boolean().optional(),
    current: z.string().optional(),
    latest: z.unknown().optional(),
    config: z
      .object({
        autoUpdate: z
          .object({
            appliedImageUpdatedAt: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export function getSystemUpdateStatus() {
  return rawApi('/api/system/update', SystemUpdateStatusSchema);
}
