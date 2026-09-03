// General system-probe contracts backing the onboarding wizard's raw
// `fetch('/api/system/...')` call sites (sb/no-raw-api-fetch sweep). Every
// route here shapes its own `NextResponse.json(...)` body directly — none
// of them are wrapped in `withApiHandler`'s `{ ok, data }` envelope — so
// everything goes through `rawApi`/`mutateRawApi`. Schemas are lenient
// (optional fields / `.passthrough()`) wherever the wizard only reads a
// subset of the body.

import { z } from 'zod';
import { rawApi, mutateRawApi } from './client';

// ---------------------------------------------------------------------------
// GET /api/system/version
// ---------------------------------------------------------------------------

export const SystemVersionSchema = z.object({ version: z.string() }).passthrough();

/** GET /api/system/version — informational; callers swallow failures. */
export function fetchSystemVersion() {
  return rawApi('/api/system/version', SystemVersionSchema);
}

// ---------------------------------------------------------------------------
// POST /api/system/diagnose
// ---------------------------------------------------------------------------

/**
 * Lenient — the wizard only reads id/label/status/detail off each probe;
 * the full shape (actions, items, group, …) is `DiagnoseProbe` in
 * `components/DiagnoseProbeList.tsx` on the frontend side.
 */
export const DiagnoseProbeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    status: z.string(),
    detail: z.string(),
  })
  .passthrough();

export const DiagnoseResultSchema = z.object({
  node: z.string().optional(),
  probes: z.array(DiagnoseProbeSchema),
});
export type DiagnoseResult = z.infer<typeof DiagnoseResultSchema>;

/** POST /api/system/diagnose */
export function runSystemDiagnose(node?: string) {
  return mutateRawApi('/api/system/diagnose', DiagnoseResultSchema, node ? { node } : {});
}

// ---------------------------------------------------------------------------
// GET /api/system/gateway/detect
// ---------------------------------------------------------------------------

export const GatewayDetectSchema = z.object({
  success: z.boolean(),
  gateway: z.string(),
});

/** GET /api/system/gateway/detect */
export function detectGateway() {
  return rawApi('/api/system/gateway/detect', GatewayDetectSchema);
}

// ---------------------------------------------------------------------------
// GET/POST /api/system/storage — RAID + block-device layout, and mounting
// a detected array. Kept intentionally strict on the fields the #2626
// storage guard relies on (device/mountpoint/degraded, …): a malformed
// response should fail validation and surface as "disk layout unknown"
// rather than being coerced into a shape that looks safe when it isn't.
// ---------------------------------------------------------------------------

export const RaidArraySchema = z
  .object({
    device: z.string(),
    label: z.string(),
    fstype: z.string(),
    size: z.string(),
    mountpoint: z.string().nullable(),
    degraded: z.boolean(),
  })
  .passthrough();
export type RaidArray = z.infer<typeof RaidArraySchema>;

export interface DetectedDrive {
  name: string;
  path: string;
  type: string;
  size: string;
  model?: string;
  vendor?: string;
  serial?: string;
  rota?: boolean;
  fstype?: string;
  label?: string;
  mountpoint?: string | null;
  fsAvail?: string;
  fsUsedPct?: string;
  children?: DetectedDrive[];
}

export const DetectedDriveSchema: z.ZodType<DetectedDrive> = z.lazy(() =>
  z
    .object({
      name: z.string(),
      path: z.string(),
      type: z.string(),
      size: z.string(),
      model: z.string().optional(),
      vendor: z.string().optional(),
      serial: z.string().optional(),
      rota: z.boolean().optional(),
      fstype: z.string().optional(),
      label: z.string().optional(),
      mountpoint: z.string().nullable().optional(),
      fsAvail: z.string().optional(),
      fsUsedPct: z.string().optional(),
      children: z.array(DetectedDriveSchema).optional(),
    })
    .passthrough(),
);

export const StorageLayoutSchema = z
  .object({
    raids: z.array(RaidArraySchema).optional(),
    drives: z.array(DetectedDriveSchema).optional(),
  })
  .passthrough();

/** GET /api/system/storage?node=… */
export function fetchStorageLayout(node: string) {
  return rawApi(`/api/system/storage?node=${node}`, StorageLayoutSchema);
}

export const MountAttemptSchema = z
  .object({
    mounted: z.boolean().optional(),
    error: z.string().optional(),
    persistent: z.boolean().optional(),
    incomplete: z.array(z.string()).optional(),
  })
  .passthrough();
export type MountAttempt = z.infer<typeof MountAttemptSchema>;

export interface MountRequest {
  device: string;
  mountpoint: string;
  label?: string;
  fstype?: string;
}

/** POST /api/system/storage?node=… — mount a detected RAID array. */
export function mountStorageArray(node: string, body: MountRequest) {
  return mutateRawApi(`/api/system/storage?node=${node}`, MountAttemptSchema, body);
}

// ---------------------------------------------------------------------------
// GET /api/system/devices
// ---------------------------------------------------------------------------

export const DeviceListSchema = z.object({ devices: z.array(z.string()) });

/** GET /api/system/devices?node=…&path=… */
export function fetchDeviceList(node: string, path: string) {
  return rawApi(`/api/system/devices?node=${node}&path=${path}`, DeviceListSchema);
}
