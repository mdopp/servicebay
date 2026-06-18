// Disk-import — resolve the Immich External-Library provisioning inputs the
// worker container needs, and shape them into `podman run -e` env args (#1954).
//
// The worker (one-shot container) provisions the per-user Immich External
// Libraries + triggers a scan after an --apply that wrote photos, but it has NO
// access to the encrypted secret store, the seeded admin credentials, or the
// LLDAP directory — those live in the control plane. So the launcher resolves
// them HERE and injects only the result into the container:
//
//   IMMICH_SERVER_URL      loopback Immich URL (host network)
//   IMMICH_ADMIN_API_KEY   the single stored admin x-api-key (reconcile-or-mint)
//   DISK_IMPORT_BOX_USERS  JSON `[{ id, email }, …]` (the routing owner axis)
//
// Best-effort: when Immich isn't installed / the key can't be resolved, we inject
// NOTHING and the worker's apply just places photos in the folder (graceful skip).
// The key is passed via `-e` (env), never logged.

import type { BoxUser, ImmichAdminConfig } from '@servicebay/disk-import-worker';

import { loadSavedSecrets } from '@/lib/install/savedSecrets';
import { getConfig } from '@/lib/config';
import { listLldapUsers } from '@/lib/lldap/client';
import { logger } from '@/lib/logger';

import { IMMICH_ADMIN_API_KEY_VAR, reconcileImmichApiKey } from './reconcileImmichApiKey';

/** Immich loopback base URL on the box (host network). No trailing slash. */
export const IMMICH_SERVER_URL = 'http://127.0.0.1:2283';

/**
 * Resolve the Immich admin config + box-user list for the HOST-side apply
 * (#1954/#1972). The control plane owns the encrypted secret store, the seeded
 * admin credentials, and the LLDAP directory; the post-apply Immich External
 * Library provision/scan now runs IN servicebay (not the worker), so it resolves
 * the same inputs HERE and uses them directly. Returns `null` when no admin key
 * is available (Immich not installed / login rejected) — the apply then just
 * places photos in the folder and skips the scan (graceful no-op). Never throws,
 * never logs the key.
 */
export async function resolveImmichProvision(): Promise<{ cfg: ImmichAdminConfig; boxUsers: BoxUser[] } | null> {
  try {
    const reconcile = await reconcileImmichApiKey(IMMICH_SERVER_URL);
    const adminApiKey = loadSavedSecrets(await getConfig())[IMMICH_ADMIN_API_KEY_VAR];
    if (!adminApiKey) {
      logger.warn(
        'disk-import:immich',
        `No Immich admin API key after reconcile (${reconcile.outcome}) — ` +
          `the post-apply Immich library scan will be skipped: ${reconcile.message}`,
      );
      return null;
    }
    const users = await listLldapUsers();
    const boxUsers: BoxUser[] = users.ok ? users.users.map(u => ({ id: u.id, email: u.email })) : [];
    return { cfg: { serverUrl: IMMICH_SERVER_URL, adminApiKey }, boxUsers };
  } catch (e) {
    logger.warn(
      'disk-import:immich',
      `Skipping Immich provisioning (apply will place photos only): ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}

/**
 * Resolve the worker's Immich-provisioning env args. Reconciles (mint-once,
 * idempotent) the admin API key, enumerates box users, and returns the flat
 * `['-e', 'VAR=value', …]` array to splice into the `podman run` argv. Returns
 * `[]` (inject nothing → worker skips provisioning) when no admin key is
 * available — Immich not installed, admin login rejected, etc. Never throws and
 * never logs the key.
 */
export async function resolveImmichProvisionEnv(): Promise<string[]> {
  try {
    const reconcile = await reconcileImmichApiKey(IMMICH_SERVER_URL);
    const adminApiKey = loadSavedSecrets(await getConfig())[IMMICH_ADMIN_API_KEY_VAR];
    if (!adminApiKey) {
      // Don't fail the launch, but DON'T fail silently either — a no-op Immich
      // scan must be diagnosable. Surface the reconcile outcome (it carries the
      // exact missing-credential reason) so it's visible in the logs.
      logger.warn(
        'disk-import:immich',
        `No Immich admin API key after reconcile (${reconcile.outcome}) — ` +
          `the post-apply Immich library scan will be skipped: ${reconcile.message}`,
      );
      return [];
    }

    const users = await listLldapUsers();
    const boxUsers = users.ok ? users.users.map(u => ({ id: u.id, email: u.email })) : [];

    return [
      '-e', `IMMICH_SERVER_URL=${IMMICH_SERVER_URL}`,
      '-e', `IMMICH_ADMIN_API_KEY=${adminApiKey}`,
      '-e', `DISK_IMPORT_BOX_USERS=${JSON.stringify(boxUsers)}`,
    ];
  } catch (e) {
    // Provisioning is best-effort — a resolve failure must NOT block the scan/
    // apply launch (the photos still land on disk).
    logger.warn(
      'disk-import:immich',
      `Skipping Immich provisioning env (apply will place photos only): ${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
}
