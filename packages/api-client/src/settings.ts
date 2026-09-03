// Settings and system configuration API contracts.
//
// Covers gateway, MCP, update window, reverse proxy, nginx credentials,
// public domain migration, boot settings, and the access/security endpoints.
//
// Every route reached from here shapes its own body with
// `NextResponse.json(...)`, so `withApiHandler`'s `{ ok, data }` auto-envelope
// never wraps it — the success body IS the payload. That makes
// `rawApi`/`mutateRawApi` the right helpers throughout this module;
// `callApi`/`mutateApi` would fail schema validation on every call.

import { z } from 'zod';
import { rawApi, mutateRawApi, TypedFetchError } from './client';
import { apiFetch } from './apiFetch';

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

/** POST /api/settings/gateway answers a bare ack, not the settings view. */
export const GatewayAckSchema = z.object({ ok: z.boolean() });

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

/**
 * POST /api/system/nginx/credentials answers `rekeyNpmAdmin`'s result — an
 * outcome + operator-facing message, NOT the CredState view. A refusal comes
 * back as `{ ok: false, message }` at HTTP 400.
 */
export const RekeyResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  email: z.string().optional(),
});

export type RekeyResult = z.infer<typeof RekeyResultSchema>;

/** DELETE /api/system/nginx/credentials answers a bare ack. */
export const CredForgetAckSchema = z.object({ ok: z.boolean() });

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

/** POST/DELETE /api/system/boot/usb-next answer an ack, not the boot status. */
export const BootActionResponseSchema = z.object({
  success: z.boolean(),
  bootNum: z.string().optional(),
  warning: z.string().optional(),
  message: z.string().optional(),
});

export type BootActionResponse = z.infer<typeof BootActionResponseSchema>;

// ---------------------------------------------------------------------------
// API Methods - Gateway
// ---------------------------------------------------------------------------

/** GET /api/settings/gateway */
export function fetchGatewaySettings() {
  return rawApi('/api/settings/gateway', GatewaySettingsSchema);
}

/** POST /api/settings/gateway */
export function updateGatewaySettings(
  host: string,
  username: string,
  password: string,
  ssl: boolean,
  test: boolean,
) {
  return mutateRawApi('/api/settings/gateway', GatewayAckSchema, {
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
  return rawApi(url, McpAuditResponseSchema);
}

// ---------------------------------------------------------------------------
// API Methods - Settings (MCP toggles)
// ---------------------------------------------------------------------------

/** GET /api/settings */
export function fetchSettings() {
  return rawApi('/api/settings', McpSettingsSchema);
}

// ---------------------------------------------------------------------------
// GET /api/settings — onboarding-wizard prefill slice
// ---------------------------------------------------------------------------
//
// Same route as `fetchSettings` above, read for a different slice of the
// (much larger) `AppConfig` body: the baked-in public domain and the
// operator's notification email, both used only to pre-fill wizard fields.
// Lenient/optional throughout — a missing section just means "nothing to
// pre-fill", not a load failure.

export const OnboardingPrefillSettingsSchema = z
  .object({
    reverseProxy: z.object({ publicDomain: z.string().optional() }).passthrough().optional(),
    notifications: z
      .object({
        email: z.object({ to: z.array(z.string()).optional() }).passthrough().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type OnboardingPrefillSettings = z.infer<typeof OnboardingPrefillSettingsSchema>;

/** GET /api/settings — wizard prefill slice (publicDomain / notify email). */
export function fetchOnboardingPrefillSettings() {
  return rawApi('/api/settings', OnboardingPrefillSettingsSchema);
}

/** POST /api/settings */
export function updateSettings(update: SettingsUpdate) {
  return mutateRawApi('/api/settings', McpSettingsSchema, update);
}

// ---------------------------------------------------------------------------
// API Methods - System Mode
// ---------------------------------------------------------------------------

/** GET /api/system/mode */
export function fetchSystemMode() {
  return rawApi('/api/system/mode', ModeInfoSchema);
}

// ---------------------------------------------------------------------------
// API Methods - Public Domain Migration
// ---------------------------------------------------------------------------

/** GET /api/system/reverse-proxy/preflight */
export function checkMigrationPreflight(publicDomain: string) {
  const url = `/api/system/reverse-proxy/preflight?publicDomain=${encodeURIComponent(publicDomain)}`;
  return rawApi(url, PreflightStatusSchema);
}

/** POST /api/system/reverse-proxy/migrate-to-public */
export function migrateToPublicDomain(publicDomain: string, dryRun: boolean) {
  return mutateRawApi(
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
  return rawApi('/api/system/nginx/credentials', CredStateSchema);
}

/** POST /api/system/nginx/credentials - Re-key NPM admin credentials */
export function rekeyNginxCredentials() {
  return mutateRawApi('/api/system/nginx/credentials', RekeyResultSchema, {});
}

/** DELETE /api/system/nginx/credentials - Forget stored credentials */
export function forgetNginxCredentials() {
  return mutateRawApi('/api/system/nginx/credentials', CredForgetAckSchema, undefined, 'DELETE');
}

// ---------------------------------------------------------------------------
// API Methods - Update Window
// ---------------------------------------------------------------------------

/** GET /api/system/update-window */
export function fetchUpdateWindow() {
  return rawApi('/api/system/update-window', UpdateWindowResponseSchema);
}

/** PUT /api/system/update-window */
export function updateUpdateWindow(window: WindowConfig) {
  return mutateRawApi('/api/system/update-window', UpdateWindowResponseSchema, window, 'PUT');
}

// ---------------------------------------------------------------------------
// API Methods - Boot Settings
// ---------------------------------------------------------------------------

/** GET /api/system/boot/usb-next */
export function fetchBootStatus() {
  return rawApi('/api/system/boot/usb-next', BootStatusSchema);
}

/** POST /api/system/boot/usb-next */
export function setBootNext(reboot: boolean, bootNum?: string) {
  return mutateRawApi('/api/system/boot/usb-next', BootActionResponseSchema, { reboot, bootNum });
}

/** DELETE /api/system/boot/usb-next */
export function cancelBootNext() {
  return mutateRawApi('/api/system/boot/usb-next', BootActionResponseSchema, undefined, 'DELETE');
}

// ---------------------------------------------------------------------------
// Access Requests Schemas
// ---------------------------------------------------------------------------

export const AccessRequestSchema = z.object({
  id: z.string(),
  requestedAt: z.string(),
  name: z.string(),
  email: z.string(),
  message: z.string().optional(),
  username: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  status: z.enum(['pending', 'approved', 'denied', 'resolved']),
  resolvedAt: z.string().optional(),
  kind: z.string().optional(),
  requestedBy: z.string().optional(),
});

export type AccessRequest = z.infer<typeof AccessRequestSchema>;

export const AccessRequestsResponseSchema = z.object({
  requests: z.array(AccessRequestSchema),
});

export type AccessRequestsResponse = z.infer<typeof AccessRequestsResponseSchema>;

export const LldapUrlResponseSchema = z.object({
  url: z.string().nullable().optional(),
});

export type LldapUrlResponse = z.infer<typeof LldapUrlResponseSchema>;

export const ApproveAccessRequestResponseSchema = z.object({
  ok: z.boolean().optional(),
  lldapUrl: z.string().nullable().optional(),
});

export type ApproveAccessRequestResponse = z.infer<typeof ApproveAccessRequestResponseSchema>;

// ---------------------------------------------------------------------------
// API Methods - Access Requests
//
// These routes predate the api-client migration and shape their own
// response bodies with `NextResponse.json(...)` — they are never wrapped
// in `withApiHandler`'s `{ ok, data }` envelope, so they go through
// `rawApi`/`mutateRawApi`, not `callApi`/`mutateApi`.
// ---------------------------------------------------------------------------

/** GET /api/system/access-requests */
export function fetchAccessRequests() {
  return rawApi('/api/system/access-requests', AccessRequestsResponseSchema);
}

/** PATCH /api/system/access-requests/:id — body unread; only success/failure matters. */
export function resolveAccessRequest(id: string) {
  return mutateRawApi(`/api/system/access-requests/${id}`, z.object({ ok: z.boolean().optional() }), undefined, 'PATCH');
}

/** POST /api/system/access-requests/:id/approve */
export function approveAccessRequest(id: string) {
  return mutateRawApi(`/api/system/access-requests/${id}/approve`, ApproveAccessRequestResponseSchema, undefined);
}

/** POST /api/system/access-requests/:id/welcome — body unread; only success/failure matters. */
export function resendWelcomeEmail(id: string) {
  return mutateRawApi(`/api/system/access-requests/${id}/welcome`, z.object({ ok: z.boolean().optional() }), undefined);
}

/** DELETE /api/system/access-requests/:id — body unread; only success/failure matters. */
export function deleteAccessRequest(id: string) {
  return mutateRawApi(`/api/system/access-requests/${id}`, z.object({ ok: z.boolean().optional() }), undefined, 'DELETE');
}

// ---------------------------------------------------------------------------
// Auth Schemas
// ---------------------------------------------------------------------------

/** GET /api/auth/lldap-url */
export function fetchLldapUrl() {
  return rawApi('/api/auth/lldap-url', LldapUrlResponseSchema);
}

// ---------------------------------------------------------------------------
// MCP Bootstrap & API Tokens Schemas
// ---------------------------------------------------------------------------

export const BootstrapStatusSchema = z.union([
  z.object({ active: z.literal(false), present: z.boolean().optional() }),
  z.object({
    active: z.literal(true),
    present: z.boolean().optional(),
    expiresAt: z.string().nullable(),
    minutesRemaining: z.number().nullable(),
  }),
]);

export type BootstrapStatus = z.infer<typeof BootstrapStatusSchema>;

// Mirrors the frontend's own `TokenView` (settings/_lib/apiTokenSelection.ts,
// `Omit<ApiToken, 'hash'>` server-side) structurally. `scopes` stays
// `string[]` here — the `ApiScope` literal union is frontend-internal
// (`@/lib/auth/apiScope`), not part of api-client's surface — so callers
// narrow with a cast at the assignment site, same as any other API response
// assigned into a more specific local type.
export const TokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  prefix: z.string(),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
  createdBy: z.string(),
});

export type TokenView = z.infer<typeof TokenViewSchema>;

export const TokenSummarySchema = z.object({
  total: z.number(),
  expiredInGrace: z.number(),
  neverExpires: z.number(),
  neverUsed: z.number(),
  dormant: z.number(),
  privileged: z.number(),
  graceDays: z.number(),
});

export type TokenSummary = z.infer<typeof TokenSummarySchema>;

export const ApiTokensResponseSchema = z.object({
  tokens: z.array(TokenViewSchema),
  // Always present in production; several unit-test mocks return only
  // `{ tokens }`, so both stay optional to match the section's own
  // `data.summary ?? null` / `data.currentTokenId ?? null` fallbacks.
  summary: TokenSummarySchema.optional(),
  currentTokenId: z.string().nullable().optional(),
});

export type ApiTokensResponse = z.infer<typeof ApiTokensResponseSchema>;

export const CreateTokenRequestSchema = z.object({
  name: z.string(),
  scopes: z.array(z.string()),
  neverExpires: z.boolean().optional(),
});

export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;

export const CreateTokenResponseSchema = z.object({
  // The minted token record minus its hash — untyped here since callers
  // only ever read `secret` off this response (the list re-fetch after
  // creation is what populates the token table).
  token: z.unknown(),
  secret: z.string(),
});

export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;

// Neither response's body is read by any caller today — both are
// fire-and-forget (`ApiTokensSection` refreshes status unconditionally
// afterward) — so every field stays optional rather than making a body
// shape neither caller inspects a reason to throw.
export const RevokeBootstrapResponseSchema = z.object({
  ok: z.boolean().optional(),
  removed: z.boolean().optional(),
});

export const ReactivateBootstrapResponseSchema = z.object({
  ok: z.boolean().optional(),
  expiresAt: z.string().optional(),
  minutesRemaining: z.number().optional(),
  status: BootstrapStatusSchema.optional(),
});

// ---------------------------------------------------------------------------
// API Methods - MCP Bootstrap
//
// Legacy raw-JSON routes (never wrapped in `withApiHandler`'s envelope) —
// `rawApi`/`mutateRawApi`, not `callApi`/`mutateApi`. See the note on the
// Access Requests methods above.
// ---------------------------------------------------------------------------

/** GET /api/system/mcp-bootstrap */
export function fetchBootstrapStatus() {
  return rawApi('/api/system/mcp-bootstrap', BootstrapStatusSchema);
}

/** DELETE /api/system/mcp-bootstrap */
export function revokeBootstrap() {
  return mutateRawApi('/api/system/mcp-bootstrap', RevokeBootstrapResponseSchema, undefined, 'DELETE');
}

/**
 * POST /api/system/mcp-bootstrap. Throws (like every other `rawApi` call)
 * on the route's one documented failure — no bootstrap entry to
 * re-activate, HTTP 409 `{ ok: false, reason }` (no `error` field, so the
 * thrown message is the generic `HTTP 409`, not the reason). The caller
 * (`ApiTokensSection`) never inspected this response before the migration
 * either — it's fire-and-forget, refreshing status regardless — so it
 * catches and ignores here too.
 */
export function reactivateBootstrap() {
  return mutateRawApi('/api/system/mcp-bootstrap', ReactivateBootstrapResponseSchema, undefined);
}

// ---------------------------------------------------------------------------
// API Methods - API Tokens
// ---------------------------------------------------------------------------

/** GET /api/system/api-tokens */
export function fetchApiTokens() {
  return rawApi('/api/system/api-tokens', ApiTokensResponseSchema);
}

/** POST /api/system/api-tokens */
export function createApiToken(request: CreateTokenRequest) {
  return mutateRawApi('/api/system/api-tokens', CreateTokenResponseSchema, request);
}

/** DELETE /api/system/api-tokens?id=<id> — body unread by the caller (only success/failure matters). */
export function revokeApiToken(id: string) {
  return mutateRawApi(`/api/system/api-tokens?id=${id}`, z.object({ ok: z.boolean().optional() }), undefined, 'DELETE');
}

// ---------------------------------------------------------------------------
// Approvals Schemas
// ---------------------------------------------------------------------------

export const ApprovalRequestSchema = z.object({
  id: z.string(),
  service: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  node: z.string(),
  created_at: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
});

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalsResponseSchema = z.object({
  approvals: z.array(ApprovalRequestSchema),
});

export type ApprovalsResponse = z.infer<typeof ApprovalsResponseSchema>;

export const ApprovalDecisionResponseSchema = z.object({
  restarted: z.boolean().optional(),
  restartError: z.string().optional(),
  error: z.string().optional(),
});

export type ApprovalDecisionResponse = z.infer<typeof ApprovalDecisionResponseSchema>;

// ---------------------------------------------------------------------------
// API Methods - Approvals
// ---------------------------------------------------------------------------

/** GET /api/approvals */
export function fetchApprovals() {
  return rawApi('/api/approvals', ApprovalsResponseSchema);
}

/** POST /api/approvals/:id/approve or /reject */
export function decideApproval(id: string, decision: 'approve' | 'reject') {
  return mutateRawApi(
    `/api/approvals/${encodeURIComponent(id)}/${decision}`,
    ApprovalDecisionResponseSchema,
    undefined,
  );
}

// ---------------------------------------------------------------------------
// System Credentials Schemas (Credential Manager)
// ---------------------------------------------------------------------------
//
// Mirrors `CredentialView` / `CredentialUrlHost`
// (`@/lib/stackInstall/credentialsManifest`, re-exported via `lib-types.ts`)
// structurally, so the parsed response is assignable where those types are
// expected without a cast.

export const CredentialViewSchema = z.object({
  service: z.string(),
  url: z.string(),
  username: z.string(),
  importance: z.enum(['critical', 'system']),
  notes: z.string().optional(),
  template: z.string().optional(),
  secured: z.boolean(),
});

export const CredentialUrlHostSchema = z.object({
  domain: z.string(),
  service: z.string(),
});

export const SystemCredentialsSchema = z.object({
  manifest: z.object({
    savedAt: z.string(),
    credentials: z.array(CredentialViewSchema),
  }).nullable(),
  proxyHosts: z.array(CredentialUrlHostSchema),
  publicDomain: z.string().nullable(),
});

export type SystemCredentials = z.infer<typeof SystemCredentialsSchema>;

// Body unread by the caller (`CredentialsSection.onWipe` only branches on
// `res.ok`) — both fields optional so a minimal `{}` still validates.
export const DeleteSystemCredentialsResponseSchema = z.object({
  ok: z.boolean().optional(),
  alreadyEmpty: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// API Methods - System Credentials
// ---------------------------------------------------------------------------

/** GET /api/system/credentials */
export function fetchSystemCredentials() {
  return rawApi('/api/system/credentials', SystemCredentialsSchema);
}

/** DELETE /api/system/credentials */
export function deleteSystemCredentials() {
  return mutateRawApi('/api/system/credentials', DeleteSystemCredentialsResponseSchema, undefined, 'DELETE');
}

// ---------------------------------------------------------------------------
// Email Notifications Schemas
// ---------------------------------------------------------------------------

export const EmailTestResponseSchema = z.object({
  ok: z.boolean(),
  sentTo: z.string().optional(),
});

export type EmailTestResponse = z.infer<typeof EmailTestResponseSchema>;

// ---------------------------------------------------------------------------
// API Methods - Email Notifications
// ---------------------------------------------------------------------------

/** POST /api/system/notifications/email/test — Body: { to: string } */
export function sendTestEmail(to: string) {
  return mutateRawApi('/api/system/notifications/email/test', EmailTestResponseSchema, { to });
}

// ---------------------------------------------------------------------------
// Factory Reset Schemas
// ---------------------------------------------------------------------------

export const FactoryResetResponseSchema = z.object({
  reset: z.object({
    deleted: z.array(z.string()).optional(),
    wipeStepsRun: z.array(z.string()).optional(),
  }).optional(),
  config: z.object({
    cleared: z.array(z.string()).optional(),
  }).optional(),
});

export type FactoryResetResponse = z.infer<typeof FactoryResetResponseSchema>;

// ---------------------------------------------------------------------------
// API Methods - Factory Reset
// ---------------------------------------------------------------------------

/** POST /api/system/factory-reset — `confirm` must be the literal 'FACTORY-RESET'. */
export function initiateFactoryReset(confirm: 'FACTORY-RESET', node?: string) {
  return mutateRawApi('/api/system/factory-reset', FactoryResetResponseSchema, { confirm, node });
}

// ---------------------------------------------------------------------------
// File Share (Samba) Schemas
// ---------------------------------------------------------------------------

export const SambaUserSchema = z.object({
  id: z.string(),
  displayName: z.string().optional(),
  email: z.string().optional(),
  presentInSamba: z.boolean(),
});

export type SambaUser = z.infer<typeof SambaUserSchema>;

export const SambaUsersResponseSchema = z.object({
  ok: z.literal(true),
  users: z.array(SambaUserSchema),
  added: z.array(z.string()),
  removed: z.array(z.string()),
});

export type SambaUsersResponse = z.infer<typeof SambaUsersResponseSchema>;

export const SetPasswordResponseSchema = z.object({
  ok: z.literal(true),
  userId: z.string(),
  password: z.string(),
});

export type SetPasswordResponse = z.infer<typeof SetPasswordResponseSchema>;

// ---------------------------------------------------------------------------
// API Methods - File Share (Samba)
// ---------------------------------------------------------------------------

/** GET /api/system/file-share/samba/users — also runs the LLDAP↔Samba sync. */
export function fetchSambaUsers() {
  return rawApi('/api/system/file-share/samba/users', SambaUsersResponseSchema);
}

/** POST /api/system/file-share/samba/users/:id/set-password — always mints a fresh random password. */
export function setSambaUserPassword(id: string) {
  return mutateRawApi(
    `/api/system/file-share/samba/users/${encodeURIComponent(id)}/set-password`,
    SetPasswordResponseSchema,
    {},
  );
}

// ---------------------------------------------------------------------------
// Portal Settings Schemas
// ---------------------------------------------------------------------------

export const PortalSettingsSchema = z.object({
  maxUsers: z.number(),
  portalLanOnly: z.boolean(),
  /** Only present on GET — the PUT echo omits it. */
  defaultMaxUsers: z.number().optional(),
});

export type PortalSettings = z.infer<typeof PortalSettingsSchema>;

export const UpdatePortalSettingsRequestSchema = z.object({
  maxUsers: z.number().int().positive().max(100000),
  portalLanOnly: z.boolean(),
});

export type UpdatePortalSettingsRequest = z.infer<typeof UpdatePortalSettingsRequestSchema>;

// ---------------------------------------------------------------------------
// API Methods - Portal Settings
// ---------------------------------------------------------------------------

/** GET /api/system/portal-settings */
export function fetchPortalSettings() {
  return rawApi('/api/system/portal-settings', PortalSettingsSchema);
}

/** PUT /api/system/portal-settings */
export function updatePortalSettings(settings: UpdatePortalSettingsRequest) {
  return mutateRawApi('/api/system/portal-settings', PortalSettingsSchema, settings, 'PUT');
}

// ---------------------------------------------------------------------------
// Settings View (full config) Schemas — GET/POST /api/settings
// ---------------------------------------------------------------------------
//
// Same route as fetchSettings/updateSettings above, but a wider slice: the
// settings-context provider (SettingsContext.tsx) reads registries,
// serverName, template settings/schema and email notifications, not just the
// `mcp` toggles. A legacy install persisted `registries` as a bare array
// before the `{ enabled, items }` shape landed — tolerate both rather than
// blanking the whole registries section on an old config. `.passthrough()`
// because this consumer reads only a slice of the persisted AppConfig; the
// rest (gateway, reverseProxy, agent, mcp, auth, …) rides along unread.

export const RegistryConfigSchema = z.object({
  name: z.string(),
  url: z.string(),
  branch: z.string().optional(),
});

export type RegistryConfigView = z.infer<typeof RegistryConfigSchema>;

export const RegistriesSettingsSchema = z.union([
  z.array(RegistryConfigSchema),
  z.object({ enabled: z.boolean(), items: z.array(RegistryConfigSchema) }),
]);

export const TemplateSettingsSchemaEntrySchema = z.object({
  default: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

export const EmailNotificationsSchema = z.object({
  enabled: z.boolean(),
  host: z.string(),
  port: z.number(),
  secure: z.boolean(),
  user: z.string(),
  pass: z.string(),
  from: z.string(),
  to: z.array(z.string()).optional(),
});

export type EmailNotificationsView = z.infer<typeof EmailNotificationsSchema>;

export const SettingsViewSchema = z
  .object({
    serverName: z.string().optional(),
    registries: RegistriesSettingsSchema.optional(),
    templateSettings: z.record(z.string(), z.string()).optional(),
    /** GET-only — computed by the route, never persisted, so the POST echo omits it. */
    templateSettingsSchema: z.record(z.string(), TemplateSettingsSchemaEntrySchema).optional(),
    notifications: z
      .object({
        email: EmailNotificationsSchema.optional(),
      })
      .optional(),
  })
  .passthrough();

export type SettingsView = z.infer<typeof SettingsViewSchema>;

/** The subset of AppConfig the settings-context provider writes back. */
export interface SettingsViewUpdate {
  serverName?: string;
  templateSettings?: Record<string, string>;
  registries?: { enabled: boolean; items: RegistryConfigView[] };
  notifications?: { email?: EmailNotificationsView };
}

// ---------------------------------------------------------------------------
// API Methods - Settings View
// ---------------------------------------------------------------------------

/** GET /api/settings — the settings-context view (see the note above). */
export function fetchSettingsView() {
  return rawApi('/api/settings', SettingsViewSchema);
}

/** POST /api/settings — the settings-context view (see the note above). */
export function saveSettingsView(update: SettingsViewUpdate) {
  return mutateRawApi('/api/settings', SettingsViewSchema, update);
}

// ---------------------------------------------------------------------------
// Bulk Token Revoke Schemas
// ---------------------------------------------------------------------------

export const BulkRevokeResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export type BulkRevokeResult = z.infer<typeof BulkRevokeResultSchema>;

export const BulkRevokeReportSchema = z.object({
  requested: z.number(),
  revoked: z.number(),
  results: z.array(BulkRevokeResultSchema),
});

export type BulkRevokeReport = z.infer<typeof BulkRevokeReportSchema>;

// ---------------------------------------------------------------------------
// API Methods - Bulk Token Revoke
// ---------------------------------------------------------------------------

/**
 * POST /api/system/api-tokens/revoke — encodes its outcome in the STATUS
 * (200 all revoked, 207 partial, 422 none), with the per-token report as the
 * body in all three cases. `rawApi`'s res.ok-means-success assumption is
 * wrong for the 422 case — an all-failed run is still a valid report, not an
 * error to discard. 207 happens to fall inside the 2xx range, so it slips
 * through unnoticed; 422 does not. Goes through the bare `apiFetch` (still
 * gets the one 401 -> /login handler) with manual parsing instead of
 * rawApi/mutateRawApi.
 */
export async function bulkRevokeApiTokens(ids: string[]): Promise<BulkRevokeReport> {
  const res = await apiFetch('/api/system/api-tokens/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  const raw: unknown = await res.json().catch(() => null);
  const parsed = BulkRevokeReportSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const message =
    raw && typeof raw === 'object' && typeof (raw as { error?: unknown }).error === 'string'
      ? (raw as { error: string }).error
      : `Bulk revoke failed — HTTP ${res.status}`;
  throw new TypedFetchError(message, raw, res.status);
}
