/**
 * `hermes_chat` probe (#1761) — surfaces the maintenance-chat assistant's
 * reachability and, crucially, distinguishes an API-KEY MISMATCH (Hermes
 * answers 401) from a genuine outage (loopback refused / not installed).
 *
 * The painful failure mode (#1761): Hermes is an external OSCAR template
 * ServiceBay does NOT render, so the engine's `API_SERVER_KEY` and
 * ServiceBay's stored `HERMES_API_KEY` can drift (each side generated its
 * own). When they drift the chat route sends the wrong bearer, Hermes
 * answers 401, and the operator sees "the assistant is unavailable" with no
 * way to repair it short of a reinstall.
 *
 * This probe fires `fail` on a 401 with the dedicated `reconcile_hermes_api_key`
 * heal-action — a one-click "adopt the running engine's key" that survives a
 * Hermes redeploy without a reinstall (reconcile-not-generate, ADR 0009 style,
 * mirroring the OIDC reconcile in #1741). A genuine outage stays a calm
 * `warn`/`info` with no false "key mismatch" claim.
 *
 * Skip cases:
 *   - No `hermes` template installed → nothing to probe (info).
 *
 * SECURITY: the probe reaches Hermes through the same server-side client as
 * the chat route — the bearer key is read from `installedSecrets` (encrypted
 * at rest) in the backend and is never logged or surfaced.
 */
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { HermesClient, HermesError, resolveHermesConnection } from '@/lib/hermes/client';
import { reconcileHermesApiKey } from '@/lib/hermes/reconcileHermesApiKey';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'hermes_chat';

export interface HermesChatResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
}

/** Probe the maintenance-chat path: classify reachable / 401 / unreachable. */
export async function checkHermesChat(): Promise<HermesChatResult> {
  const config = await getConfig();
  if (!config.installedTemplates?.hermes) {
    return {
      status: 'info',
      detail: 'Hermes template not installed — no maintenance-chat assistant to probe.',
    };
  }

  const conn = resolveHermesConnection(config);
  const client = new HermesClient(conn, 5000);
  if (!client.configured) {
    return {
      status: 'warn',
      detail: 'Hermes is installed but no API key is stored for it yet.',
      hint: 'Click "Reconcile Hermes API key" to adopt the running engine\'s key so maintenance chat can authenticate.',
    };
  }

  try {
    // listSessions is a cheap authenticated GET — a 200 proves both
    // reachability and a matching key.
    await client.listSessions();
    return {
      status: 'ok',
      detail: 'Maintenance-chat assistant is reachable and authenticating.',
    };
  } catch (e) {
    if (e instanceof HermesError && e.status === 401) {
      return {
        status: 'fail',
        detail:
          'Hermes rejected the stored API key (401) — ServiceBay\'s key has drifted from the running engine.',
        hint: 'Click "Reconcile Hermes API key" to adopt the key the running Hermes container actually uses. No reinstall needed.',
      };
    }
    return {
      status: 'warn',
      detail: 'Hermes is installed but the maintenance-chat endpoint is not responding.',
      hint: 'Check that the hermes service is running (Services → hermes). This is a connectivity issue, not a key mismatch.',
    };
  }
}

// ---------------------------------------------------------------------------
// Action: adopt the running engine's API key. Reconcile-not-generate — reads
// the live `API_SERVER_KEY` over the loopback exec seam and stores it. Never
// regenerates a key (that would break the running engine). Idempotent.
// ---------------------------------------------------------------------------

async function reconcileHermesKeyAction({ node }: { node: string }): Promise<ProbeActionResult> {
  const result = await reconcileHermesApiKey(node);
  switch (result.outcome) {
    case 'changed':
      return { ok: true, message: result.message, refresh: true };
    case 'aligned':
      return { ok: true, message: result.message, refresh: true };
    case 'not-found':
      return { ok: false, message: result.message, refresh: false };
    default:
      logger.warn('diagnose:hermes_chat', `reconcile action failed: ${result.message}`);
      return { ok: false, message: result.message, refresh: false };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'reconcile_hermes_api_key',
    label: 'Reconcile Hermes API key',
    description:
      'Adopts the API key the running Hermes engine actually uses (read over the loopback exec seam) into ServiceBay’s stored secret. Use when maintenance chat fails with an auth/401 error after a Hermes redeploy. Never regenerates a key (that would break the running engine); idempotent — a no-op when the keys already match.',
  },
  reconcileHermesKeyAction,
);
