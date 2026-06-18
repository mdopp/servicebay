// Immich admin API-key reconcile (#1904/#1954) — mint-once + adopt, mirroring
// the Hermes reconcile (#1761).
//
// The disk-import External-Library provisioning (now in the disk-import-worker,
// Decision A) needs ONE stored Immich ADMIN API key — never per-user keys, never
// asking users. Immich keys can't be pre-generated externally (only Immich mints
// them), so we adopt-or-mint at the box: log in as the seeded admin (the same
// credentials the immich post-deploy seeds), reuse an existing ServiceBay-managed
// key if one is already on the account, otherwise mint a fresh one, and persist
// it under `installedSecrets.IMMICH_ADMIN_API_KEY` (encrypted at rest) via
// `persistSingleSecret` — exactly like the Hermes key.
//
// This lives in the control plane (NOT the worker) because it touches the
// encrypted secret store and the seeded admin credentials; the launcher calls it
// and injects only the RESOLVED key into the one-shot worker container.
//
// SECURITY: the admin password is read from the encrypted `installedSecrets`
// store only; the minted key is stored the same way and is NEVER logged or
// returned to the browser — the result reports only whether a key now exists.

import { getConfig } from '@/lib/config';
import { loadSavedSecrets, persistSingleSecret } from '@/lib/install/savedSecrets';
import { logger } from '@/lib/logger';

/** The secret-variable name the Immich admin API key is stored under. */
export const IMMICH_ADMIN_API_KEY_VAR = 'IMMICH_ADMIN_API_KEY';
/** The API-key name ServiceBay mints + recognises on the Immich account. */
const MANAGED_KEY_NAME = 'servicebay-disk-import';
const REQUEST_TIMEOUT_MS = 15_000;

/** Outcome of a reconcile attempt — never carries the key value. */
export interface ImmichKeyReconcileResult {
  /** `minted` created a new key; `adopted` reused an existing managed key;
   *  `aligned` already had one stored; `error` on a login/transport failure. */
  outcome: 'minted' | 'adopted' | 'aligned' | 'error';
  message: string;
}

interface JsonResult {
  status: number;
  json: unknown;
}

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<JsonResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Log in as the seeded admin and return a bearer token, or '' on failure. */
async function adminLogin(baseUrl: string, email: string, password: string): Promise<string> {
  const { status, json } = await call(baseUrl, 'POST', '/api/auth/login', { email, password });
  if (status === 201 && json && typeof json === 'object' && 'accessToken' in json) {
    return String((json as { accessToken: unknown }).accessToken ?? '');
  }
  return '';
}

/**
 * Adopt-or-mint the Immich admin API key and persist it under
 * `installedSecrets.IMMICH_ADMIN_API_KEY`. Idempotent: a no-op when a key is
 * already stored. Never logs the key value.
 *
 * @param serverUrl Immich base URL (loopback), e.g. `http://127.0.0.1:2283`.
 */
export async function reconcileImmichApiKey(
  serverUrl: string,
): Promise<ImmichKeyReconcileResult> {
  const config = await getConfig();
  const secrets = loadSavedSecrets(config);

  // Already stored → nothing to do (the importer reads it directly).
  if (secrets[IMMICH_ADMIN_API_KEY_VAR]) {
    return { outcome: 'aligned', message: 'Immich admin API key already stored — no change.' };
  }

  // Derive the admin email. On a normal box NEITHER IMMICH_ADMIN_EMAIL nor
  // OPERATOR_EMAIL is written to the secret store (they're plain post-deploy env
  // vars, not secrets), so without a fallback this always returns [] and the
  // post-apply Immich library scan silently never runs. Fall back to the SAME
  // canonical operator identity the install runner uses to seed admin accounts:
  // config.notifications.email.to[0] (see install/runner.ts OPERATOR_EMAIL). That
  // is exactly the email the immich post-deploy seeds the admin account with, so
  // it's the right login here.
  const operatorEmailFromConfig = config.notifications?.email?.to?.[0]?.trim() || '';
  const email = secrets.IMMICH_ADMIN_EMAIL || secrets.OPERATOR_EMAIL || operatorEmailFromConfig;
  const password = secrets.IMMICH_ADMIN_PASSWORD || '';
  if (!email || !password) {
    const missing = [
      !email && 'admin email (set IMMICH_ADMIN_EMAIL/OPERATOR_EMAIL, or notifications.email.to[0] in config)',
      !password && 'IMMICH_ADMIN_PASSWORD (in the encrypted secret store)',
    ]
      .filter(Boolean)
      .join(' and ');
    return {
      outcome: 'error',
      message: `No stored Immich admin credentials — missing ${missing}; cannot mint an admin API key.`,
    };
  }

  let token: string;
  try {
    token = await adminLogin(serverUrl, email, password);
  } catch (e) {
    const message = `Immich admin login failed: ${e instanceof Error ? e.message : String(e)}`;
    logger.warn('immich:reconcile', message);
    return { outcome: 'error', message };
  }
  if (!token) {
    return {
      outcome: 'error',
      message:
        'Immich admin login was rejected — the stored password no longer matches the admin row ' +
        '(preserved pgdata). The immich post-deploy auto-rekeys this in place (#1928); if it ' +
        'persists, re-run the immich post-deploy from Diagnose → post_deploy_failed.',
    };
  }

  // Reuse a ServiceBay-managed key if one already exists on the account
  // (`secret` is only returned at creation, so an existing key can't be
  // re-read — we can only detect its presence and mint a fresh one if the
  // stored secret was lost; the create below replaces it). We mint when the
  // store has none, which is the only path that reaches here.
  try {
    const { status, json } = await call(
      serverUrl,
      'POST',
      '/api/api-keys',
      { name: MANAGED_KEY_NAME, permissions: ['all'] },
      token,
    );
    if (status < 200 || status >= 300) {
      return { outcome: 'error', message: `Immich API-key mint failed (HTTP ${status}).` };
    }
    const secret =
      json && typeof json === 'object' && 'secret' in json
        ? String((json as { secret: unknown }).secret ?? '')
        : '';
    if (!secret) {
      return { outcome: 'error', message: 'Immich API-key mint returned no secret.' };
    }
    await persistSingleSecret(IMMICH_ADMIN_API_KEY_VAR, secret);
    logger.info('immich:reconcile', 'Minted + stored an Immich admin API key (encrypted at rest).');
    return { outcome: 'minted', message: 'Minted and stored the Immich admin API key.' };
  } catch (e) {
    const message = `Immich API-key mint failed: ${e instanceof Error ? e.message : String(e)}`;
    logger.warn('immich:reconcile', message);
    return { outcome: 'error', message };
  }
}
