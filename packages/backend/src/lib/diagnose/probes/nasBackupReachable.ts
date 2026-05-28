/**
 * `nas_backup_reachable` probe — guards the FritzBox-NAS config-survival
 * feature (#1224 / #1190). During #1190 verification the FritzBox had file
 * sharing turned off, so config backups silently never landed and nobody
 * noticed until a reinstall needed them. This probe surfaces that proactively:
 * is the backup target configured, reachable + authenticated, and writable?
 *
 * Transport is FTP (the feature pivoted away from SMB — see nasClient.ts), so
 * "reachable + authed" is one FTP access+pwd, and "writable" is a probe-file
 * round-trip into sb-backup/. Auth failures, plain unreachability, and a
 * read-only / no-drive target are surfaced distinctly.
 */
import { getNasTarget, testNasConnection, nasUpload, nasRemove } from '@/lib/externalBackup/nasClient';
import { NAS_BACKUP_DIR } from '@/lib/externalBackup/producer';
import { logger } from '@/lib/logger';

export interface NasBackupProbeResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
}

const ENABLE_SHARING_HINT =
  'On the FritzBox: attach a USB drive, then enable file sharing under ' +
  'Heimnetz → Speicher (NAS) → Heimnetzfreigabe (turn on access over FTP). ' +
  'Confirm the gateway user (Settings → Integrations) is allowed to write to it.';

/** Distinguish a login rejection from a plain connectivity failure so the
 *  remediation hint points at the right thing. */
function looksLikeAuthFailure(error: string): boolean {
  return /530|login|incorrect|denied|credential|password|auth/i.test(error);
}

export async function checkNasBackupReachable(): Promise<NasBackupProbeResult> {
  const target = await getNasTarget();
  if (!target) {
    return {
      status: 'info',
      detail: 'Config-backup NAS not configured — no FritzBox gateway with credentials in Settings → Integrations.',
      hint: 'Add the FritzBox gateway (host + login) to enable config backups to the NAS.',
    };
  }

  const conn = await testNasConnection();
  if (!conn.ok) {
    const auth = looksLikeAuthFailure(conn.error);
    return {
      status: 'warn',
      detail: auth
        ? `Reached ${target.host} but authentication failed: ${conn.error}`
        : `Could not reach the FritzBox NAS at ${target.host}: ${conn.error}`,
      hint: auth
        ? 'Check the gateway username/password in Settings → Integrations match a FritzBox user allowed to access the NAS.'
        : ENABLE_SHARING_HINT,
    };
  }

  // Connected + authed — confirm we can actually write where backups go.
  // ensureDir + upload + remove exercises the full write path without leaving
  // anything behind on the share.
  const probePath = `${NAS_BACKUP_DIR}/.sb-write-test-${process.pid}-${Date.now()}`;
  try {
    await nasUpload(probePath, Buffer.from('servicebay-write-test'));
    await nasRemove(probePath);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    logger.warn('diagnose:nas_backup_reachable', `write test failed: ${error}`);
    return {
      status: 'warn',
      detail: `Connected to ${target.host}, but writing to ${NAS_BACKUP_DIR}/ failed: ${error}`,
      hint: ENABLE_SHARING_HINT,
    };
  }

  return {
    status: 'ok',
    detail: `FritzBox NAS at ${target.host} is reachable and writable — config backups will land in ${NAS_BACKUP_DIR}/.`,
  };
}
