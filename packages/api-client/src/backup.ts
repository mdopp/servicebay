// Backup and restore API contracts. Phase 2 of the FE/BE separation (#762)
// — frontend routes backup dashboard fetches through typed methods.
//
// Every route in this module predates the api-client migration and shapes
// its own body with `NextResponse.json(...)`, so `withApiHandler`'s auto
// envelope never kicks in — the success body is the payload itself. That
// makes `rawApi`/`mutateRawApi` (not `callApi`/`mutateApi`) the correct
// helpers here; `callApi` would fail schema validation on every call.
// Callers wrap responses in try/catch to handle TypedFetchError on
// validation failure or non-2xx status.

import { z } from 'zod';
import { rawApi, mutateRawApi } from './client';
import { apiFetch } from './apiFetch';

// ---------------------------------------------------------------------------
// Schema definitions
// ---------------------------------------------------------------------------

/** Backup target for sync operations (local, SSH, SMB, NFS) */
export const BackupTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('local'),
    path: z.string(),
  }),
  z.object({
    type: z.literal('ssh'),
    host: z.string(),
    port: z.number(),
    user: z.string(),
    path: z.string(),
    identityFile: z.string().optional(),
  }),
  z.object({
    type: z.literal('smb'),
    host: z.string(),
    share: z.string(),
    path: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }),
  z.object({
    type: z.literal('nfs'),
    host: z.string(),
    export: z.string(),
    path: z.string().optional(),
  }),
]);

export type BackupTarget = z.infer<typeof BackupTargetSchema>;

/** Backup sync configuration */
export const BackupSyncConfigSchema = z.object({
  enabled: z.boolean(),
  schedule: z.enum(['hourly', 'daily', 'weekly', 'monthly']),
  time: z.string(),
  dayOfWeek: z.number().optional(),
  dayOfMonth: z.number().optional(),
  target: BackupTargetSchema,
  sources: z.array(
    z.object({
      path: z.string(),
      excludePatterns: z.array(z.string()),
    }),
  ),
});

export type BackupSyncConfig = z.infer<typeof BackupSyncConfigSchema>;

/** Response from GET /api/settings/backup-sync */
 
export const BackupSyncStateSchema = z.any();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BackupSyncState = any;

/** Generic success response */
export const SuccessResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

/** Test result for backup target */
export const BackupTestResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export type BackupTestResult = z.infer<typeof BackupTestResultSchema>;

/** System backup entry */
export const BackupEntrySchema = z.object({
  fileName: z.string(),
  createdAt: z.string(),
  size: z.number(),
  kind: z.string().optional(),
});

export type BackupEntry = z.infer<typeof BackupEntrySchema>;

/** Response from GET /api/settings/backups */
 
export const BackupListResponseSchema = z.any();

/** Backup progress event from POST /api/settings/backups stream */
export const BackupProgressEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('log'),
    entry: z.string(),
  }),
  z.object({
    type: z.literal('done'),
    backup: BackupEntrySchema,
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
  }),
]);

export type BackupProgressEvent = z.infer<typeof BackupProgressEventSchema>;

/** Response from POST /api/settings/backups/preview */
export const BackupPreviewResponseSchema = z.object({
  preview: z.unknown(),  // BackupPreviewResult from @/lib/systemBackup
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('stored'),
      fileName: z.string(),
    }),
    z.object({
      type: z.literal('upload'),
      token: z.string(),
    }),
  ]),
});

export type BackupPreviewResponse = z.infer<typeof BackupPreviewResponseSchema>;

/** Response from POST /api/settings/backups/file */
export const BackupFileResponseSchema = z.object({
  content: z.string(),
});

export type BackupFileResponse = z.infer<typeof BackupFileResponseSchema>;

/** Response from POST /api/settings/backups/restore (direct) */
export const RestoreResponseSchema = z.object({
  success: z.boolean(),
  restored: BackupEntrySchema.optional(),
});

export type RestoreResponse = z.infer<typeof RestoreResponseSchema>;

/** External backup target types */
 
export const ExternalBackupTargetSchema = z.any();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExternalBackupTarget = any;

/** Response from GET /api/system/external-backup/target */
export const ExternalBackupTargetResponseSchema = z.object({
  ok: z.boolean(),
  target: ExternalBackupTargetSchema.optional(),
});

export type ExternalBackupTargetResponse = z.infer<typeof ExternalBackupTargetResponseSchema>;

/**
 * Response from POST /api/system/external-backup/target with action: 'test'.
 * `testCandidateTarget` answers `{ ok: false, error }` at HTTP 200, so a failed
 * probe is a value the caller renders, not a thrown TypedFetchError.
 */
export const ExternalBackupTestResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export type ExternalBackupTestResult = z.infer<typeof ExternalBackupTestResultSchema>;

/** Response from POST /api/system/external-backup/backup-now */
export const BackupNowResponseSchema = z.object({
  ok: z.boolean(),
  backedUp: z.number(),
  total: z.number(),
  results: z.array(
    z.object({
      service: z.string(),
      ok: z.boolean(),
      tarName: z.string().optional(),
      size: z.number().optional(),
      error: z.string().optional(),
    }),
  ),
});

export type BackupNowResponse = z.infer<typeof BackupNowResponseSchema>;

/** Response from GET /api/system/external-backup/list */
 
export const ExternalBackupListResponseSchema = z.any();

export type ExternalBackupListResponse = z.infer<typeof ExternalBackupListResponseSchema>;

/**
 * Response from POST /api/system/external-backup/restore — `{ ok: true }`
 * spread with `restoreServiceBackup`'s result. Only the fields the Backup page
 * renders are pinned; the rest (meta, credentialReconcile) are passed through.
 */
export const ExternalBackupRestoreResponseSchema = z.object({
  ok: z.boolean().optional(),
  service: z.string().optional(),
  dataDir: z.string().optional(),
  files: z.number().optional(),
});

export type ExternalBackupRestoreResponse = z.infer<typeof ExternalBackupRestoreResponseSchema>;

/** Response from POST /api/system/external-backup/delete */
export const ExternalBackupDeleteResponseSchema = z.object({
  ok: z.boolean().optional(),
  tarName: z.string().optional(),
  metaRemoved: z.boolean().optional(),
});

export type ExternalBackupDeleteResponse = z.infer<typeof ExternalBackupDeleteResponseSchema>;

/** Response from GET /api/settings/backup-sync/mounts */
 
export const MountsResponseSchema = z.any();

export type MountsResponse = z.infer<typeof MountsResponseSchema>;

// ---------------------------------------------------------------------------
// Backup Sync API methods
// ---------------------------------------------------------------------------

/** GET /api/settings/backup-sync */
export function fetchBackupSyncState() {
  return rawApi('/api/settings/backup-sync', BackupSyncStateSchema);
}

/** POST /api/settings/backup-sync with action: 'save' */
export function saveBackupSync(config: BackupSyncConfig) {
  return mutateRawApi('/api/settings/backup-sync', SuccessResponseSchema, {
    action: 'save',
    config,
  });
}

/** POST /api/settings/backup-sync with action: 'run' */
export function runBackupSync() {
  return mutateRawApi('/api/settings/backup-sync', SuccessResponseSchema, {
    action: 'run',
  });
}

/** POST /api/settings/backup-sync with action: 'test' */
export function testBackupSyncTarget(target: BackupTarget) {
  return mutateRawApi('/api/settings/backup-sync', BackupTestResultSchema, {
    action: 'test',
    target,
  });
}

/** GET /api/settings/backup-sync/mounts */
export function fetchBackupSyncMounts() {
  return rawApi('/api/settings/backup-sync/mounts', MountsResponseSchema);
}

// ---------------------------------------------------------------------------
// System Backups API methods
// ---------------------------------------------------------------------------

/** GET /api/settings/backups */
export function fetchSystemBackups() {
  return rawApi('/api/settings/backups', BackupListResponseSchema);
}

/** DELETE /api/settings/backups */
export function deleteSystemBackup(fileName: string) {
  return mutateRawApi('/api/settings/backups', SuccessResponseSchema, { fileName }, 'DELETE');
}

/** POST /api/settings/backups/preview */
export function previewSystemBackup(input: { fileName: string } | FormData) {
  const init: RequestInit = {
    method: 'POST',
  };

  if (input instanceof FormData) {
    init.body = input;
  } else {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(input);
  }

  return rawApi('/api/settings/backups/preview', BackupPreviewResponseSchema, init);
}

/** POST /api/settings/backups/file */
export function fetchBackupFile(
  fileName: string | undefined,
  uploadToken: string | undefined,
  nodeName: string,
  relativePath: string,
) {
  return mutateRawApi('/api/settings/backups/file', BackupFileResponseSchema, {
    fileName,
    uploadToken,
    nodeName,
    relativePath,
  });
}

/** POST /api/settings/backups/restore */
export function restoreSystemBackup(
  input: {
    fileName?: string;
    uploadToken?: string;
    selection?: unknown;
  },
) {
  return mutateRawApi('/api/settings/backups/restore', RestoreResponseSchema, input, 'POST');
}

// ---------------------------------------------------------------------------
// External Backup API methods
// ---------------------------------------------------------------------------

/** GET /api/system/external-backup/target */
export function fetchExternalBackupTarget() {
  return rawApi('/api/system/external-backup/target', ExternalBackupTargetResponseSchema);
}

/** POST /api/system/external-backup/target with action: 'save' */
export function saveExternalBackupTarget(target: ExternalBackupTarget) {
  return mutateRawApi('/api/system/external-backup/target', ExternalBackupTargetResponseSchema, {
    action: 'save',
    target,
  });
}

/** POST /api/system/external-backup/target with action: 'test' */
export function testExternalBackupTarget(target: ExternalBackupTarget) {
  return mutateRawApi('/api/system/external-backup/target', ExternalBackupTestResultSchema, {
    action: 'test',
    target,
  });
}

/** POST /api/system/external-backup/backup-now */
export function backupNowToExternal(service?: string) {
  return mutateRawApi('/api/system/external-backup/backup-now', BackupNowResponseSchema, {
    service,
  });
}

/** GET /api/system/external-backup/list */
export function fetchExternalBackupList() {
  return rawApi('/api/system/external-backup/list', ExternalBackupListResponseSchema);
}

/**
 * POST /api/system/external-backup/restore. The route keys off `service` and
 * takes `tarName` to pin the SPECIFIC snapshot the operator picked (#1865) —
 * both fields are required by the handler.
 */
export function restoreFromExternalBackup(service: string, tarName?: string) {
  return mutateRawApi('/api/system/external-backup/restore', ExternalBackupRestoreResponseSchema, {
    service,
    ...(tarName ? { tarName } : {}),
  });
}

/** POST /api/system/external-backup/delete — the route validates `tarName`. */
export function deleteExternalBackup(service: string, tarName: string) {
  return mutateRawApi('/api/system/external-backup/delete', ExternalBackupDeleteResponseSchema, {
    service,
    tarName,
  });
}

// ---------------------------------------------------------------------------
// Streaming API methods
// ---------------------------------------------------------------------------

/**
 * POST /api/settings/backups (streaming)
 *
 * Creates a new system backup, streaming progress as NDJSON.
 * Returns the raw Response so callers can read from the body stream.
 * Goes through apiFetch for 401 handling.
 */
export async function createSystemBackupStream(): Promise<Response> {
  return apiFetch('/api/settings/backups', { method: 'POST' });
}
