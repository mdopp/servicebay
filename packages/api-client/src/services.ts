// Service form / YAML manifest contracts. Phase 2 of the FE/BE
// separation (#759) — frontend stops importing `js-yaml` for the
// live editor; validation goes through `POST /api/services/validate-yaml`
// instead.

import { z } from 'zod';
import { rawApi, mutateRawApi } from './client';

// ---------------------------------------------------------------------------
// POST /api/services/validate-yaml
// ---------------------------------------------------------------------------

export const ValidateYamlRequestSchema = z.object({
  yaml: z.string(),
});

const HumanizedYamlErrorSchema = z.object({
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  raw: z.string(),
});

// Parsed manifest fields that ServiceForm extracts. Shape mirrors the
// `KubeDoc` interface it used to feed into `extractInfo`. Loose where
// js-yaml is loose — every field is optional so partial / malformed
// inputs still round-trip without losing what *was* parseable.
const KubeVolumeSchema = z
  .object({
    name: z.string().optional(),
    hostPath: z.object({ path: z.string().optional() }).optional(),
    persistentVolumeClaim: z.object({ claimName: z.string().optional() }).optional(),
  })
  .passthrough();

const KubeVolumeMountSchema = z
  .object({
    name: z.string().optional(),
    mountPath: z.string().optional(),
  })
  .passthrough();

const KubePortSchema = z
  .object({
    containerPort: z.number().optional(),
    hostPort: z.number().optional(),
    protocol: z.string().optional(),
  })
  .passthrough();

const KubeContainerSchema = z
  .object({
    name: z.string().optional(),
    image: z.string().optional(),
    ports: z.array(KubePortSchema).optional(),
    volumeMounts: z.array(KubeVolumeMountSchema).optional(),
  })
  .passthrough();

export const KubeDocSchema = z
  .object({
    kind: z.string().optional(),
    metadata: z.object({ name: z.string().optional() }).passthrough().optional(),
    spec: z
      .object({
        containers: z.array(KubeContainerSchema).optional(),
        volumes: z.array(KubeVolumeSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const ValidateYamlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), manifest: KubeDocSchema }),
  z.object({ ok: z.literal(false), error: HumanizedYamlErrorSchema }),
]);

// ---------------------------------------------------------------------------
// GET/DELETE /api/services/:name, POST /api/services/:name/action
// ---------------------------------------------------------------------------
//
// The Operate-page tabs (Actions/Settings) talk to the single-service route
// and its /action sibling. Every response here is a raw NextResponse.json(...)
// body (withApiHandlerParams only wraps the auth/validation, never the
// success payload with `{ ok, data }` when the handler returns a Response
// itself), so rawApi/mutateRawApi throughout — never callApi/mutateApi.

/** All fields optional/tolerant: a Quadlet `.container` unit has no yaml, a
 *  service that never had a systemd unit written yet has no servicePath, and
 *  callers only read what they need. */
export const ServiceFilesSchema = z
  .object({
    kubeContent: z.string().optional(),
    yamlContent: z.string().optional(),
    yamlPath: z.string().optional(),
    serviceContent: z.string().optional(),
    kubePath: z.string().optional(),
    servicePath: z.string().optional(),
    quadletKind: z.enum(['kube', 'container']).optional(),
  })
  .passthrough();

export type ServiceFilesView = z.infer<typeof ServiceFilesSchema>;

/** GET /api/services/:name?node=… — the service's on-disk kube/yaml/unit
 *  files. `cache: 'no-store'` — the Settings tab always wants the live file,
 *  never a stale browser-cached read. */
export function fetchServiceFiles(name: string, nodeName?: string) {
  const query = nodeName ? `?node=${encodeURIComponent(nodeName)}` : '';
  return rawApi(`/api/services/${encodeURIComponent(name)}${query}`, ServiceFilesSchema, { cache: 'no-store' });
}

const ServiceDeleteResultSchema = z.object({ success: z.boolean().optional() }).passthrough();

/** DELETE /api/services/:name?node=… */
export function deleteServiceByName(name: string, nodeName?: string) {
  const query = nodeName ? `?node=${encodeURIComponent(nodeName)}` : '';
  return mutateRawApi(`/api/services/${encodeURIComponent(name)}${query}`, ServiceDeleteResultSchema, undefined, 'DELETE');
}

// The 'start'/'stop'/'restart'/'update' success body is unread by every
// caller today — each re-derives its toast from the request it sent and
// re-fetches state separately — so it's left unvalidated. `force-update`'s
// report IS read; see ForceUpdateReportSchema below.
const ServiceActionAckSchema = z.unknown();

/** POST /api/services/:name/action?node=… — action: 'start'|'stop'|'restart'|'update'. */
export function runServiceAction(
  name: string,
  action: 'start' | 'stop' | 'restart' | 'update',
  nodeName?: string,
) {
  const query = nodeName ? `?node=${encodeURIComponent(nodeName)}` : '';
  return mutateRawApi(`/api/services/${encodeURIComponent(name)}/action${query}`, ServiceActionAckSchema, { action });
}

/**
 * Mirrors the frontend's own `ForceUpdateReport` (OperateActionsTab.tsx) —
 * narrow view of the backend's `ForceUpdateResult` (#2397). The route always
 * answers 200 on a normal call; a thrown-exception 500 still lands an
 * `error` field via the shared ApiErrorBody envelope, which happens to be
 * the same field name, so a caller reading `report.error` gets a sensible
 * message either way.
 */
export const ForceUpdateReportSchema = z
  .object({
    changed: z.boolean().optional(),
    stale: z.boolean().optional(),
    mode: z.enum(['pull', 'fresh']).optional(),
    images: z
      .array(
        z.object({
          image: z.string(),
          changed: z.boolean().optional(),
          stale: z.boolean().optional(),
          error: z.string().optional(),
        }),
      )
      .optional(),
    error: z.string().optional(),
  })
  .passthrough();

export type ForceUpdateReportView = z.infer<typeof ForceUpdateReportSchema>;

/** POST /api/services/:name/action?node=… — action: 'force-update'. */
export function runForceUpdateAction(name: string, mode: 'pull' | 'fresh', nodeName?: string) {
  const query = nodeName ? `?node=${encodeURIComponent(nodeName)}` : '';
  return mutateRawApi(
    `/api/services/${encodeURIComponent(name)}/action${query}`,
    ForceUpdateReportSchema,
    { action: 'force-update', mode },
  );
}

// ---------------------------------------------------------------------------
// GET /api/services — the full listing (name/status/etc per service, plus
// synthetic gateway/link/self rows). Lenient — most callers of this schema
// only read `.name`, so every field beyond it is optional passthrough
// rather than re-deriving the route's full response shape here.
// ---------------------------------------------------------------------------

export const ServiceSummarySchema = z.object({ name: z.string().optional() }).passthrough();

export const ServiceSummaryListSchema = z.array(ServiceSummarySchema);

/** GET /api/services?node=… — bare array, not the `{ok,data}` envelope. */
export function fetchServiceSummaries(node?: string) {
  const query = node ? `?node=${node}` : '';
  return rawApi(`/api/services${query}`, ServiceSummaryListSchema);
}
