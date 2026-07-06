/**
 * `install_handler_failed` probe (#2160 / #2161) — surfaces install-time
 * failures that left a service in a silent half-state and that the install
 * itself could NOT recover from:
 *
 *   - `capability`: a `feature.installed` capability handler (Authelia OIDC
 *     client, NPM proxy host, AdGuard rewrite) that stayed failed after the
 *     runner's bounded retries. The service is "installed" but its SSO /
 *     proxy registration never landed → invalid_client or no route.
 *   - `restore`: a NAS auto-restore that failed, so the service came up on
 *     default config while the operator believes their state was restored.
 *
 * Symmetric with `post_deploy_failed`: each standing failure is one item
 * with a retry/reconcile action so the operator can recover it long after
 * the install log scrolled away — while the backup still exists, in the
 * restore case. Reads the persistent store `config.installHandlerFailures`
 * (`lib/install/handlerFailures.ts`); a successful retry clears the record.
 */

import { logger } from '@/lib/logger';
import { internalFetch } from '@/lib/api/internalFetch';
import { getConfig } from '@/lib/config';
import { buildOidcReconcilePayload } from '@/lib/capabilities/authelia';
import {
  listHandlerFailures,
  clearHandlerFailure,
  handlerFailureKey,
} from '@/lib/install/handlerFailures';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

export const PROBE_ID = 'install_handler_failed';

export interface InstallHandlerFailedResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

export async function checkInstallHandlerFailed(): Promise<InstallHandlerFailedResult> {
  const failures = await listHandlerFailures();
  if (failures.length === 0) {
    return {
      status: 'ok',
      detail: 'No unresolved install-time capability or restore failures.',
    };
  }
  const items: ProbeItem[] = failures.map(f => ({
    id: handlerFailureKey(f.kind, f.service),
    label: f.service,
    detail:
      `${f.kind === 'restore' ? 'NAS restore' : 'capability registration'} failed at ` +
      `${new Date(f.lastFailedAt).toLocaleString()} — ${f.message}`,
    status: 'warn',
    actionIds: ['retry_install_handler', 'dismiss_install_handler'],
  }));
  return {
    status: 'warn',
    detail:
      `${failures.length} service${failures.length === 1 ? '' : 's'} finished installing in a degraded state — ` +
      `a capability handler (SSO/proxy) or a NAS restore didn't complete. The service is up but on incomplete/default config.`,
    hint: 'Click "Retry" on a row to re-run the failed step (re-register the OIDC client / re-restore from the NAS). Idempotent — already-done work is skipped.',
    items,
  };
}

/** Parse `${kind}:${service}` back into its parts. */
function parseItemId(itemId: string): { kind: 'capability' | 'restore'; service: string } | null {
  const idx = itemId.indexOf(':');
  if (idx < 0) return null;
  const kind = itemId.slice(0, idx);
  const service = itemId.slice(idx + 1);
  if ((kind !== 'capability' && kind !== 'restore') || !service) return null;
  return { kind, service };
}

/** Re-run the capability registration for a service by reconciling its OIDC
 *  client(s) — the concrete recoverable case (Authelia registration races,
 *  authelia.ts:142). The POST endpoint is reconcile-first (skips already-
 *  registered client_ids, never rotates a secret), so this is idempotent. */
async function retryCapability(service: string): Promise<ProbeActionResult> {
  const cfg = await getConfig();
  const payload = await buildOidcReconcilePayload({
    installedTemplates: Object.keys(cfg.installedTemplates ?? {}),
    publicDomain: cfg.reverseProxy?.publicDomain,
  });
  if (!payload) {
    // Nothing to reconcile (no public domain / no OIDC-declaring template).
    // The failure was likely a non-OIDC handler (proxy/DNS) — clear the
    // stale record so the operator isn't nagged; a redeploy re-emits it.
    await clearHandlerFailure('capability', service);
    return {
      ok: true,
      message: `Cleared the ${service} record — no OIDC client to reconcile (no public domain configured). Redeploy the service to re-run proxy/DNS registration.`,
      refresh: true,
    };
  }
  let res: Response;
  try {
    res = await internalFetch('/api/system/authelia/oidc-clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return { ok: false, message: `Reconcile failed: ${e instanceof Error ? e.message : String(e)}`, refresh: false };
  }
  if (res.status === 404) {
    return { ok: false, message: 'Authelia is not deployed — install the auth stack, then retry.', refresh: false };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    const message = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    return { ok: false, message: `Reconcile failed: ${message}`, refresh: false };
  }
  await clearHandlerFailure('capability', service);
  return { ok: true, message: `Re-registered OIDC client(s) for ${service}. SSO should work now.`, refresh: true };
}

/** Re-run the NAS auto-restore for a service (force overwrite of config).
 *  Only recoverable while the backup still exists on the NAS. */
async function retryRestore(service: string): Promise<ProbeActionResult> {
  // Lazy import to keep the restore module (and its executor deps) out of
  // the probe's module-load graph.
  const { autoRestoreServiceOnReinstall } = await import('@/lib/externalBackup/restore');
  const lines: string[] = [];
  try {
    await autoRestoreServiceOnReinstall(
      service,
      { wipeMode: 'wipe-config', node: 'Local', local: true },
      async (line: string) => {
        lines.push(line);
      },
    );
  } catch (e) {
    return { ok: false, message: `Restore retry failed: ${e instanceof Error ? e.message : String(e)}`, refresh: false };
  }
  // autoRestoreServiceOnReinstall records a fresh failure if it fails again;
  // check the store to decide success vs. still-failed.
  const stillFailing = (await listHandlerFailures()).some(
    f => f.kind === 'restore' && f.service === service,
  );
  if (stillFailing) {
    const last = lines[lines.length - 1] ?? 'see install log';
    return { ok: false, message: `Restore still failing for ${service}: ${last}`, refresh: true };
  }
  await clearHandlerFailure('restore', service);
  return { ok: true, message: `Restored ${service} config from the NAS.`, refresh: true };
}

async function retryInstallHandler({ itemId }: { itemId?: string }): Promise<ProbeActionResult> {
  if (!itemId) return { ok: false, message: 'No service supplied.', refresh: false };
  const parsed = parseItemId(itemId);
  if (!parsed) return { ok: false, message: `Unrecognized item id: ${itemId}`, refresh: false };
  try {
    return parsed.kind === 'restore'
      ? await retryRestore(parsed.service)
      : await retryCapability(parsed.service);
  } catch (e) {
    logger.warn('diagnose:install_handler_failed', `retry ${itemId} threw:`, e);
    return { ok: false, message: `Retry failed: ${e instanceof Error ? e.message : String(e)}`, refresh: false };
  }
}

async function dismissInstallHandler({ itemId }: { itemId?: string }): Promise<ProbeActionResult> {
  if (!itemId) return { ok: false, message: 'No service supplied.', refresh: false };
  const parsed = parseItemId(itemId);
  if (!parsed) return { ok: false, message: `Unrecognized item id: ${itemId}`, refresh: false };
  const existed = await clearHandlerFailure(parsed.kind, parsed.service);
  return existed
    ? { ok: true, message: `Cleared the ${parsed.service} record.`, refresh: true }
    : { ok: false, message: `No standing record for ${parsed.service}.`, refresh: false };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'retry_install_handler',
    label: 'Retry',
    description:
      'Re-runs the failed install step for this service — re-registers its Authelia OIDC client (fixes SSO invalid_client) or re-restores its config from the NAS. Idempotent: already-completed work is skipped. Clears the warning on success.',
  },
  retryInstallHandler,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'dismiss_install_handler',
    label: 'Clear record',
    description:
      'Removes the persisted failure record so the probe stops surfacing it. Use when you fixed the service manually and no longer want the warning.',
  },
  dismissInstallHandler,
);
