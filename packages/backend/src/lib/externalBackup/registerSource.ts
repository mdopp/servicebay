/**
 * Register the FritzBox NAS as ServiceBay's external-backup source and surface
 * what's on it (#1440).
 *
 * The NAS target isn't a standalone config blob — it's derived from
 * `config.gateway` (the FritzBox is both the gateway and the USB-NAS host, see
 * `nasClient.getNasTarget`). So "register the backup source" means: make sure
 * `config.gateway` carries the FritzBox host + credentials, so the box knows
 * where its backups live and can list/restore them.
 *
 * The sb NAS upload (#1367) pushes a `home-assistant.tar` straight to the
 * FritzBox over FTP using creds the operator typed locally — but never told the
 * box, so the upload was invisible to install/restore. This module is the
 * missing wire-up: the TUI (or Settings) calls `registerNasSource` with those
 * same creds, and `getNasBackupOverview` then lets Settings → Backups verify
 * the connection and list the staged tars (incl. `home-assistant.tar`).
 */
import { getConfig, updateConfig, type GatewayConfig } from '../config';
import { logger } from '../logger';
import { testNasConnection } from './nasClient';
import { listServiceBackups, type ServiceBackupListEntry } from './producer';

export interface NasRegistration {
  host: string;
  username: string;
  password: string;
}

export interface RegisterResult {
  /** True when this call wrote/updated the gateway; false when it was a no-op
   *  (the same FritzBox creds were already configured). */
  changed: boolean;
  gateway: { type: 'fritzbox'; host: string; username: string };
}

/**
 * Persist the FritzBox NAS as the external-backup source by recording its
 * host + credentials in `config.gateway`. Idempotent: re-registering the same
 * host/user/password is a no-op (`changed:false`). Updating an existing
 * FritzBox gateway's creds (e.g. a rotated password) is allowed and preserves
 * its other fields (e.g. `ssl`); we only flip `type` to `fritzbox`.
 */
export async function registerNasSource(reg: NasRegistration): Promise<RegisterResult> {
  const host = reg.host.trim();
  const username = reg.username.trim();
  const password = reg.password;
  if (!host) throw new Error('host is required to register the NAS backup source');
  if (!username) throw new Error('username is required to register the NAS backup source');
  if (!password) throw new Error('password is required to register the NAS backup source');

  const existing = (await getConfig()).gateway;
  const alreadyRegistered =
    existing?.type === 'fritzbox' &&
    existing.host === host &&
    existing.username === username &&
    existing.password === password;
  if (alreadyRegistered) {
    return { changed: false, gateway: { type: 'fritzbox', host, username } };
  }

  const gateway: GatewayConfig = { ...existing, type: 'fritzbox', host, username, password };
  await updateConfig({ gateway });
  logger.info('ExternalBackup', `Registered FritzBox NAS backup source (${host}) from upload`);
  return { changed: true, gateway: { type: 'fritzbox', host, username } };
}

export interface NasBackupOverview {
  /** True when `config.gateway` carries FritzBox creds (the source is known). */
  configured: boolean;
  /** Connection probe result — null when not configured (nothing to probe). */
  connection: { ok: true } | { ok: false; error: string } | null;
  /** Service backups staged under `sb-backup/` on the NAS (empty on any error
   *  or when not configured). */
  backups: ServiceBackupListEntry[];
}

/**
 * Read the registered NAS source's status for Settings → Backups: is a source
 * configured, does it connect, and which backups are sitting on it. A failed
 * connection yields `backups: []` rather than throwing — the caller renders the
 * connection error and offers a retry/verify.
 */
export async function getNasBackupOverview(): Promise<NasBackupOverview> {
  const gw = (await getConfig()).gateway;
  const configured = gw?.type === 'fritzbox' && Boolean(gw.host && gw.username && gw.password);
  if (!configured) {
    return { configured: false, connection: null, backups: [] };
  }
  const connection = await testNasConnection();
  if (!connection.ok) {
    return { configured: true, connection, backups: [] };
  }
  try {
    const backups = await listServiceBackups();
    return { configured: true, connection, backups };
  } catch (e) {
    // The probe connected but the listing failed (e.g. sb-backup/ absent on a
    // brand-new NAS) — treat as "connected, nothing staged yet".
    logger.warn('ExternalBackup', `NAS connected but listing failed: ${e instanceof Error ? e.message : String(e)}`);
    return { configured: true, connection, backups: [] };
  }
}
