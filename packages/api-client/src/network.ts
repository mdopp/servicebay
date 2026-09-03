// Network-topology + reverse-proxy (nginx) contracts — sb/no-raw-api-fetch
// sweep (#2745 follow-up). Backs the raw `fetch('/api/...')` call sites in
// `hooks/useTopologyData.ts` and `components/ReverseProxyConfig.tsx`. Every
// route here shapes its own `NextResponse.json(...)` body directly — none of
// them are wrapped in `withApiHandler`'s `{ ok, data }` envelope — so
// `rawApi`/`mutateRawApi` throughout. Schemas are deliberately lenient
// (`.passthrough()` / optional fields): both callers only read a handful of
// fields off a much larger backend shape.

import { z } from 'zod';
import { rawApi, mutateRawApi } from './client';
import { lenientArray } from './lenient';
import type { NetworkGraph } from './lib-types';

// ---------------------------------------------------------------------------
// Network graph — GET /api/network/graph
// ---------------------------------------------------------------------------

// Lenient by design: the dashboard's own layout/render pipeline already
// tolerates a partial node/edge (it predates this typed seam and did no
// validation at all), and one malformed row must not sink the whole graph
// fetch. Only `id` is required — everything else is optional/passthrough.
const NetworkNodeSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    label: z.string().optional(),
    status: z.enum(['up', 'down', 'unknown']).optional(),
  })
  .passthrough();

const NetworkEdgeSchema = z
  .object({
    id: z.string(),
    source: z.string().optional(),
    target: z.string().optional(),
    protocol: z.string().optional(),
    port: z.number().optional(),
    state: z.string().optional(),
  })
  .passthrough();

// Per-row lenient (#2784): a node/edge that fails validation is dropped and
// logged, so one malformed row cannot collapse the whole topology to an empty
// graph. A non-array `nodes`/`edges` still fails — that is a route break.
const NetworkGraphSchema = z.object({
  nodes: lenientArray(NetworkNodeSchema, 'GET /api/network/graph#nodes'),
  edges: lenientArray(NetworkEdgeSchema, 'GET /api/network/graph#edges'),
});

/** GET /api/network/graph?node=… — raw seam. Typed as the full `NetworkGraph`
 *  (not just the schema's narrow view) so it drops straight into
 *  `useTopologyData`'s existing `NetworkGraph`-typed state. */
export function fetchNetworkGraph(node?: string): Promise<NetworkGraph> {
  const query = node ? `?node=${encodeURIComponent(node)}` : '';
  return rawApi(`/api/network/graph${query}`, NetworkGraphSchema) as Promise<NetworkGraph>;
}

// ---------------------------------------------------------------------------
// Nginx (reverse proxy) install status — GET/POST /api/system/nginx/status,
// /api/system/nginx/install
// ---------------------------------------------------------------------------

const NginxStatusSchema = z
  .object({
    installed: z.boolean(),
    active: z.boolean().optional(),
    name: z.string().optional(),
    node: z.string().optional(),
    adminPort: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type NginxStatus = z.infer<typeof NginxStatusSchema>;

/** GET /api/system/nginx/status — always 200; a probe failure is reported as
 *  `{ installed: false, error }`, not a non-OK status. */
export function fetchNginxStatus() {
  return rawApi('/api/system/nginx/status', NginxStatusSchema);
}

const NginxInstallResultSchema = z
  .object({
    success: z.boolean().optional(),
    node: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

/** POST /api/system/nginx/install */
export function installNginx() {
  return mutateRawApi('/api/system/nginx/install', NginxInstallResultSchema);
}
