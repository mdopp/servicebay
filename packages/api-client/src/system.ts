// General system-probe contracts backing the onboarding wizard's raw
// `fetch('/api/system/...')` call sites (sb/no-raw-api-fetch sweep). Every
// route here shapes its own `NextResponse.json(...)` body directly — none
// of them are wrapped in `withApiHandler`'s `{ ok, data }` envelope — so
// everything goes through `rawApi`/`mutateRawApi`. Schemas are lenient
// (optional fields / `.passthrough()`) wherever the wizard only reads a
// subset of the body.

import { z } from 'zod';
import { rawApi, mutateRawApi } from './client';
import { lenientArray } from './lenient';

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
  // Per-row lenient (#2784): a probe row from an older/newer backend is
  // dropped, the rest of the diagnose result still renders.
  probes: lenientArray(DiagnoseProbeSchema, 'POST /api/system/diagnose#probes'),
});
export type DiagnoseResult = z.infer<typeof DiagnoseResultSchema>;

/** POST /api/system/diagnose */
export function runSystemDiagnose(node?: string) {
  return mutateRawApi('/api/system/diagnose', DiagnoseResultSchema, node ? { node } : {});
}

// ---------------------------------------------------------------------------
// POST /api/system/dns/verify — backs the install wizard's Done-step DNS
// check (`DoneStepDnsCheck.tsx`). Per-domain lookup result; lenient because
// the wizard only reads domain/resolvesTo/matches/error off each row.
// ---------------------------------------------------------------------------

export const DnsVerifyResultSchema = z
  .object({
    domain: z.string(),
    resolvesTo: z.string().nullable(),
    matches: z.boolean(),
    error: z.string().optional(),
  })
  .passthrough();
export type DnsVerifyResult = z.infer<typeof DnsVerifyResultSchema>;

export const DnsVerifyResponseSchema = z.object({
  expectedIPs: z.array(z.string()).catch([]),
  // Per-row lenient (#2784): one odd domain result must not blank the
  // whole DNS-check panel.
  results: lenientArray(DnsVerifyResultSchema, 'POST /api/system/dns/verify#results'),
});
export type DnsVerifyResponse = z.infer<typeof DnsVerifyResponseSchema>;

/** POST /api/system/dns/verify — Body: { domains: string[] } */
export function verifyDnsRecords(domains: string[]) {
  return mutateRawApi('/api/system/dns/verify', DnsVerifyResponseSchema, { domains });
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
// a detected array. Kept intentionally strict on the FIELDS the #2626
// storage guard relies on (device/mountpoint/degraded, …): none of them get
// a `.catch(...)` default, so a row is never coerced into a shape that looks
// safe when it isn't. #2784 changes only the array level: such a row is now
// dropped-and-warned instead of failing the whole read, so one unparseable
// array cannot blank the entire disk list.
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
    // Per-row lenient (#2784): one odd array/drive must not empty the picker.
    raids: lenientArray(RaidArraySchema, 'GET /api/system/storage#raids').optional(),
    drives: lenientArray(DetectedDriveSchema, 'GET /api/system/storage#drives').optional(),
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
  return rawApi(
    `/api/system/devices?node=${encodeURIComponent(node)}&path=${encodeURIComponent(path)}`,
    DeviceListSchema,
  );
}

// ---------------------------------------------------------------------------
// GET/DELETE /api/system/reinstall — drives the "Welcome back — services
// restoring" banner (#337) after setup-raid restores Quadlet definitions
// from the RAID backup. Lenient: the `active:false` shape and the
// `active:true` shape share one schema with the extra fields optional.
// ---------------------------------------------------------------------------

export const ReinstallStatusSchema = z
  .object({
    active: z.boolean(),
    completedAt: z.string().optional(),
    minutesRemaining: z.number().optional(),
  })
  .passthrough();
export type ReinstallStatus = z.infer<typeof ReinstallStatusSchema>;

/** GET /api/system/reinstall */
export function fetchReinstallStatus() {
  return rawApi('/api/system/reinstall', ReinstallStatusSchema);
}

const ReinstallDismissResultSchema = z
  .object({ ok: z.boolean().optional(), removed: z.boolean().optional() })
  .passthrough();

/** DELETE /api/system/reinstall — dismiss the restore banner. */
export function dismissReinstallBanner() {
  return mutateRawApi('/api/system/reinstall', ReinstallDismissResultSchema, undefined, 'DELETE');
}

// ---------------------------------------------------------------------------
// GET /api/system/files — the file-viewer overlay's raw file read. Bare
// `NextResponse.json(...)` body (`{ content }` / `{ error }`) despite the
// route using `withApiHandler` — it returns a `Response` directly, which
// bypasses the `{ ok, data }` auto-envelope — so `rawApi`.
// ---------------------------------------------------------------------------

export const FileContentSchema = z.object({ content: z.string().catch('') }).passthrough();

/** GET /api/system/files?path=…&node=… */
export function fetchFileContent(path: string, node?: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ path });
  if (node) params.set('node', node);
  return rawApi(`/api/system/files?${params.toString()}`, FileContentSchema, { cache: 'no-store', signal });
}

// ---------------------------------------------------------------------------
// GET /api/help — the SectionHelp popover's markdown content read. Same
// bare-body shape as the file read above.
// ---------------------------------------------------------------------------

export const HelpContentSchema = z.object({ content: z.string().catch('') }).passthrough();

/** GET /api/help?id=… */
export function fetchHelpContent(id: string) {
  return rawApi(`/api/help?id=${encodeURIComponent(id)}`, HelpContentSchema);
}
