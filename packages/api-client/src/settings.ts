// Settings and system configuration API contracts.
//
// Covers gateway, MCP, update window, reverse proxy, nginx credentials,
// public domain migration, and boot settings endpoints.

import { z } from 'zod';
import { callApi, mutateApi } from './client';

// ---------------------------------------------------------------------------
// Gateway Settings Schemas
// ---------------------------------------------------------------------------

export const GatewaySettingsSchema = z.object({
  configured: z.boolean(),
  type: z.string().nullable(),
  host: z.string(),
  username: z.string(),
  hasPassword: z.boolean(),
  ssl: z.boolean(),
});

export type GatewaySettings = z.infer<typeof GatewaySettingsSchema>;

export const GatewayRequestSchema = z.object({
  host: z.string(),
  username: z.string(),
  password: z.string(),
  ssl: z.boolean(),
  test: z.boolean(),
});

export type GatewayRequest = z.infer<typeof GatewayRequestSchema>;

// ---------------------------------------------------------------------------
// MCP Audit Schemas
// ---------------------------------------------------------------------------

export const McpAuditEntrySchema = z.object({
  ts: z.string(),
  tool: z.string(),
  outcome: z.enum(['ok', 'error', 'blocked']),
  durationMs: z.number(),
  args: z.record(z.string(), z.unknown()).optional(),
  errorMessage: z.string().optional(),
});

export type McpAuditEntry = z.infer<typeof McpAuditEntrySchema>;

export const McpAuditResponseSchema = z.object({
  entries: z.array(McpAuditEntrySchema).nullable().optional(),
});

export type McpAuditResponse = z.infer<typeof McpAuditResponseSchema>;

// ---------------------------------------------------------------------------
// Settings (MCP toggles) Schemas
// ---------------------------------------------------------------------------

export const McpSettingsSchema = z.object({
  mcp: z.object({
    allowMutations: z.boolean().optional(),
    allowDangerousExec: z.boolean().optional(),
  }).optional(),
});

export type McpSettings = z.infer<typeof McpSettingsSchema>;

export const SettingsUpdateSchema = z.object({
  mcp: z.object({
    allowMutations: z.boolean().optional(),
    allowDangerousExec: z.boolean().optional(),
  }).optional(),
});

export type SettingsUpdate = z.infer<typeof SettingsUpdateSchema>;

// ---------------------------------------------------------------------------
// System Mode Schemas
// ---------------------------------------------------------------------------

export const ModeInfoSchema = z.object({
  mode: z.enum(['lan', 'public']),
  activeDomain: z.string(),
  publicDomain: z.string().nullable(),
  lanDomain: z.string().nullable(),
});

export type ModeInfo = z.infer<typeof ModeInfoSchema>;

// ---------------------------------------------------------------------------
// Public Domain Migration Schemas
// ---------------------------------------------------------------------------

export const PreflightCheckSchema = z.object({
  id: z.enum(['dns', 'http01', 'port-forward']),
  label: z.string(),
  status: z.enum(['pass', 'fail', 'unknown']),
  detail: z.string(),
});

export type PreflightCheck = z.infer<typeof PreflightCheckSchema>;

export const PreflightStatusSchema = z.object({
  publicDomain: z.string(),
  ready: z.boolean(),
  checks: z.array(PreflightCheckSchema),
});

export type PreflightStatus = z.infer<typeof PreflightStatusSchema>;

export const MigrationStepSchema = z.object({
  kind: z.enum(['npm-dual-server-name', 'authelia-config', 'cert-request']),
  domain: z.string().optional(),
  node: z.string().optional(),
  hostId: z.number().optional(),
  skipped: z.boolean().optional(),
});

export type MigrationStep = z.infer<typeof MigrationStepSchema>;

export const MigrationPlanSchema = z.object({
  publicDomain: z.string(),
  lanRoot: z.string(),
  warnings: z.array(z.string()),
  steps: z.array(MigrationStepSchema),
});

export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

export const MigrationResultSchema = z.object({
  plan: MigrationPlanSchema,
  applied: z.boolean(),
  errors: z.array(z.object({
    step: z.string(),
    detail: z.string(),
    target: z.string().optional(),
  })),
  stepResults: z.array(z.object({
    ok: z.boolean(),
    error: z.string().optional(),
  })),
});

export type MigrationResult = z.infer<typeof MigrationResultSchema>;

// ---------------------------------------------------------------------------
// Reverse Proxy (Nginx) Credentials Schemas
// ---------------------------------------------------------------------------

export const CredStatusSchema = z.enum(['ok', 'rejected', 'no-creds', 'unknown']);

export const CredStateSchema = z.object({
  configured: z.boolean(),
  email: z.string(),
  status: CredStatusSchema,
});

export type CredState = z.infer<typeof CredStateSchema>;

// ---------------------------------------------------------------------------
// Update Window Schemas
// ---------------------------------------------------------------------------

export const ApplyToSchema = z.object({
  os: z.boolean(),
  containers: z.boolean(),
  servicebay: z.boolean(),
});

export type ApplyTo = z.infer<typeof ApplyToSchema>;

export const WindowConfigSchema = z.object({
  enabled: z.boolean(),
  days: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])),
  startTime: z.string(),
  lengthMinutes: z.number(),
  applyTo: ApplyToSchema,
});

export type WindowConfig = z.infer<typeof WindowConfigSchema>;

export const UpdateWindowResponseSchema = z.object({
  window: WindowConfigSchema.partial().nullable(),
});

export type UpdateWindowResponse = z.infer<typeof UpdateWindowResponseSchema>;

// ---------------------------------------------------------------------------
// Boot Settings Schemas
// ---------------------------------------------------------------------------

export const BootEntrySchema = z.object({
  bootNum: z.string(),
  name: z.string(),
  active: z.boolean(),
  description: z.string(),
  current: z.boolean(),
});

export type BootEntry = z.infer<typeof BootEntrySchema>;

export const BootStatusSchema = z.object({
  entries: z.array(BootEntrySchema),
  candidates: z.array(BootEntrySchema),
  bootNext: z.string().nullable(),
  bootCurrent: z.string().nullable(),
  bootOrder: z.array(z.string()),
});

export type BootStatus = z.infer<typeof BootStatusSchema>;

// ---------------------------------------------------------------------------
// API Methods - Gateway
// ---------------------------------------------------------------------------

/** GET /api/settings/gateway */
export function fetchGatewaySettings() {
  return callApi('/api/settings/gateway', GatewaySettingsSchema);
}

/** POST /api/settings/gateway */
export function updateGatewaySettings(
  host: string,
  username: string,
  password: string,
  ssl: boolean,
  test: boolean,
) {
  return mutateApi('/api/settings/gateway', GatewaySettingsSchema, {
    host,
    username,
    password,
    ssl,
    test,
  });
}

// ---------------------------------------------------------------------------
// API Methods - MCP Audit
// ---------------------------------------------------------------------------

/** GET /api/system/mcp-audit */
export function fetchMcpAudit(limit?: number) {
  const url = limit
    ? `/api/system/mcp-audit?limit=${limit}`
    : '/api/system/mcp-audit';
  return callApi(url, McpAuditResponseSchema);
}

// ---------------------------------------------------------------------------
// API Methods - Settings (MCP toggles)
// ---------------------------------------------------------------------------

/** GET /api/settings */
export function fetchSettings() {
  return callApi('/api/settings', McpSettingsSchema);
}

/** POST /api/settings */
export function updateSettings(update: SettingsUpdate) {
  return mutateApi('/api/settings', McpSettingsSchema, update);
}

// ---------------------------------------------------------------------------
// API Methods - System Mode
// ---------------------------------------------------------------------------

/** GET /api/system/mode */
export function fetchSystemMode() {
  return callApi('/api/system/mode', ModeInfoSchema);
}

// ---------------------------------------------------------------------------
// API Methods - Public Domain Migration
// ---------------------------------------------------------------------------

/** GET /api/system/reverse-proxy/preflight */
export function checkMigrationPreflight(publicDomain: string) {
  const url = `/api/system/reverse-proxy/preflight?publicDomain=${encodeURIComponent(publicDomain)}`;
  return callApi(url, PreflightStatusSchema);
}

/** POST /api/system/reverse-proxy/migrate-to-public */
export function migrateToPublicDomain(publicDomain: string, dryRun: boolean) {
  return mutateApi(
    '/api/system/reverse-proxy/migrate-to-public',
    MigrationResultSchema,
    { publicDomain, dryRun },
  );
}

// ---------------------------------------------------------------------------
// API Methods - Reverse Proxy (Nginx) Credentials
// ---------------------------------------------------------------------------

/** GET /api/system/nginx/credentials */
export function fetchNginxCredentials() {
  return callApi('/api/system/nginx/credentials', CredStateSchema);
}

/** POST /api/system/nginx/credentials - Re-key NPM admin credentials */
export function rekeyNginxCredentials() {
  return mutateApi('/api/system/nginx/credentials', CredStateSchema, {});
}

/** DELETE /api/system/nginx/credentials - Forget stored credentials */
export function forgetNginxCredentials() {
  return mutateApi('/api/system/nginx/credentials', z.object({ success: z.boolean() }), undefined, 'DELETE');
}

// ---------------------------------------------------------------------------
// API Methods - Update Window
// ---------------------------------------------------------------------------

/** GET /api/system/update-window */
export function fetchUpdateWindow() {
  return callApi('/api/system/update-window', UpdateWindowResponseSchema);
}

/** PUT /api/system/update-window */
export function updateUpdateWindow(window: WindowConfig) {
  return mutateApi('/api/system/update-window', UpdateWindowResponseSchema, window, 'PUT');
}

// ---------------------------------------------------------------------------
// API Methods - Boot Settings
// ---------------------------------------------------------------------------

/** GET /api/system/boot/usb-next */
export function fetchBootStatus() {
  return callApi('/api/system/boot/usb-next', BootStatusSchema);
}

/** POST /api/system/boot/usb-next */
export function setBootNext(reboot: boolean, bootNum?: string) {
  return mutateApi('/api/system/boot/usb-next', BootStatusSchema, { reboot, bootNum });
}

/** DELETE /api/system/boot/usb-next */
export function cancelBootNext() {
  return mutateApi('/api/system/boot/usb-next', z.object({ success: z.boolean() }), undefined, 'DELETE');
}
