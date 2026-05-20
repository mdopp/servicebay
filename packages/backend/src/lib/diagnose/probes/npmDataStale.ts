/**
 * `npm_data_stale` probe — detects when Nginx Proxy Manager has rejected
 * the credentials ServiceBay has stored / auto-generated for it. Most
 * common cause: a previous install left an admin password in NPM's
 * SQLite database that no longer matches the wizard's expected one
 * (the volume survived a reinstall / restore).
 *
 * Phase 3b of the diagnose / health-check rework (#484): this probe
 * is now a **thin reader** over the health-check subsystem. The
 * actual detection runs on an `npm_auth`-type singleton check (15 min
 * interval, see `health/init.ts`) and the result is persisted to
 * `HealthStore`. Result persistence, scheduling, and the Phase 3a SSE
 * broadcast all live there — this file just reads the latest result
 * back into the diagnose narrative.
 *
 * Action `reset_volume` (destructive) wipes NPM's data dir and restarts
 * the service so it re-seeds with the wizard's INITIAL_ADMIN_*
 * credentials. Action `use_existing` (non-destructive) accepts the
 * password the operator knows works and persists it to config — no
 * data loss, the right path for "I already changed the password
 * outside the wizard."  Both action handlers stay here because they
 * mutate operator-facing state (config / NPM volume) at the moment of
 * the click — only the detection moved into the health subsystem.
 */

import { agentManager } from '@/lib/agent/manager';
import { updateConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult } from '../actions';
import { HealthStore } from '@/lib/health/store';
import { NPM_AUTH_MESSAGE_PREFIX } from '@/lib/health/runner';
import { registerRefreshNow } from './refreshHealthCheck';

export interface NpmDataStaleResult {
  /** undefined when not applicable (no nginx-web, or NPM not reachable). */
  status?: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
}

const PROBE_ID = 'npm_data_stale';
const CHECK_ID = 'npm_auth';

/** Reader: surfaces the latest persisted `npm_auth` health-check
 *  result. Diagnose route used to call this with `(nodeName)` — the
 *  arg is now unused because the singleton check captures the node
 *  via its `nodeName` field. The signature drops the arg entirely so
 *  the call site is a plain `await checkNpmDataStale()`. */
export async function checkNpmDataStale(): Promise<NpmDataStaleResult> {
  const result = HealthStore.getLastResult(CHECK_ID);
  if (!result) {
    // #664 — S4: distinguish "not yet scheduled (config missing)" from
    // "scheduled, first run pending." The npm_auth check is created
    // when ServiceBay records NPM admin credentials (see
    // `postInstall.bootstrapNpmAdmin`). If the check doesn't exist
    // yet the probe is blocked on NPM bootstrap; if it exists but has
    // no result, the scheduler will fire it shortly.
    const exists = HealthStore.getChecks().some(c => c.id === CHECK_ID);
    if (!exists) {
      return {
        status: 'info',
        detail: 'Waiting on NPM admin bootstrap — the npm_auth check is created once ServiceBay records the NPM admin credentials. Re-run after the install finishes its NPM step.',
      };
    }
    return {
      status: 'info',
      detail: 'Scheduled — first run pending. Open Settings → Health to trigger it manually.',
    };
  }
  if (result.message && result.message.startsWith(NPM_AUTH_MESSAGE_PREFIX)) {
    try {
      const json = result.message.slice(NPM_AUTH_MESSAGE_PREFIX.length);
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed.status === 'string' && typeof parsed.detail === 'string') {
        return {
          status: parsed.status,
          detail: parsed.detail,
          hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
        };
      }
    } catch {
      // fall through
    }
  }
  if (result.status === 'fail') {
    return {
      status: 'info',
      detail: `Check failed to run: ${result.message || 'unknown error'}`,
    };
  }
  return {
    status: 'info',
    detail: 'NPM auth check produced no actionable signal.',
  };
}

// ─── Action handlers (kept in the probe file) ───────────────────────────
//
// Local copy of `findNpmAdminUrl` so the click-time action paths don't
// depend on health/runner internals.  Mirrors the helper in
// `src/lib/health/probes/npmAdmin.ts` — kept duplicated because the
// action handlers run with a different lifecycle (one-shot, operator
// click) and we don't want to entangle them with the runner's import
// graph.
async function findNpmAdminUrl(node: string): Promise<string | null> {
  try {
    const services = await ServiceManager.listServices(node);
    const nginx = services.find(
      s => s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
    );
    if (!nginx?.active) return null;
    const ports = (nginx.ports ?? [])
      .map(p => parseInt(String(p.host ?? ''), 10))
      .filter(p => Number.isFinite(p) && p !== 80 && p !== 443);
    const adminPort = ports[0] ?? 81;
    return `http://localhost:${adminPort}`;
  } catch {
    return null;
  }
}

/** Action: stop nginx-web, wipe its data volume, restart it. NPM's
 *  next start re-seeds the admin user from the
 *  INITIAL_ADMIN_EMAIL/INITIAL_ADMIN_PASSWORD env vars in the kube
 *  template — i.e. the wizard's stored credentials. */
async function resetNpmVolume({ node }: { node: string }): Promise<ProbeActionResult> {
  const agent = await agentManager.ensureAgent(node);
  // Best-effort sequence: stop, wipe, start. Failures of the wipe
  // bubble up because that's the step that actually matters; stop/
  // start surface as warnings in the message but don't block.
  const stop = await agent.sendCommand('exec', {
    command: 'systemctl --user stop nginx-web.service',
  }, { timeoutMs: 30_000 });
  const stopOk = (stop as { code?: number }).code === 0;
  if (!stopOk) {
    logger.warn('diagnose:npm_data_stale', 'Stop nginx-web returned non-zero — continuing anyway', stop);
  }

  const wipe = await agent.sendCommand('exec', {
    // Wipe the SQLite database NPM uses for accounts + proxy hosts.
    // /mnt/data/stacks/nginx-web is the canonical location set in the
    // template's kube YAML. Keep the parent dir so the next start can
    // re-create the schema in place.
    command: 'rm -rf /mnt/data/stacks/nginx-web/data /mnt/data/stacks/nginx-web/letsencrypt 2>&1',
  }, { timeoutMs: 30_000 });
  if ((wipe as { code?: number }).code !== 0) {
    return {
      ok: false,
      message: `Could not wipe NPM data: ${(wipe as { stderr?: string }).stderr ?? 'unknown error'}`,
      refresh: false,
    };
  }

  const start = await agent.sendCommand('exec', {
    command: 'systemctl --user start nginx-web.service',
  }, { timeoutMs: 60_000 });
  const startOk = (start as { code?: number }).code === 0;
  return {
    ok: startOk,
    message: startOk
      ? 'NPM data reset and the service is restarting. The probe will re-run shortly; if NPM is still cold-starting it may need ~30 s before it accepts logins.'
      : `NPM data was wiped but the restart failed: ${(start as { stderr?: string }).stderr ?? 'unknown'}. Try Settings → Services → nginx-web → Start.`,
    refresh: true,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'reset_volume',
    label: 'Reset NPM data',
    description:
      'Wipes the NPM admin database and proxy-host configuration, then restarts the service so it re-seeds with the wizard credentials. Existing proxy routes will need to be re-created from your service templates.',
    destructive: true,
  },
  resetNpmVolume,
);

/**
 * Non-destructive sibling of `reset_volume` — saves credentials the
 * operator already knows are correct. Uses NPM's /api/tokens to
 * confirm the password works before persisting; if NPM still 401s we
 * surface the error rather than overwriting good config with bad.
 */
async function useExistingNpmCreds({
  node,
  payload,
}: {
  node: string;
  payload?: Record<string, unknown>;
}): Promise<ProbeActionResult> {
  const email = typeof payload?.email === 'string' ? payload.email.trim() : '';
  const password = typeof payload?.password === 'string' ? payload.password : '';
  if (!email || !password) {
    return { ok: false, message: 'Email and password are required.', refresh: false };
  }
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) {
    return {
      ok: false,
      message: 'Nginx Proxy Manager is not deployed on this node — nothing to authenticate against.',
      refresh: false,
    };
  }
  let res: Response;
  try {
    res = await fetch(`${adminUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: email, secret: password }),
      signal: AbortSignal.timeout(4000),
    });
  } catch (e) {
    return {
      ok: false,
      message: `Could not reach NPM at ${adminUrl}: ${e instanceof Error ? e.message : String(e)}`,
      refresh: false,
    };
  }
  if (res.status === 401) {
    return {
      ok: false,
      message: 'NPM still rejected those credentials — double-check the password and try again. (Nothing was saved.)',
      refresh: false,
    };
  }
  if (!res.ok) {
    return { ok: false, message: `NPM returned HTTP ${res.status} during verification.`, refresh: false };
  }
  await updateConfig({
    reverseProxy: {
      npm: { email, password },
    },
  });
  logger.info('diagnose:npm_data_stale', `Saved verified NPM credentials for ${email}`);
  return {
    ok: true,
    message: 'Credentials verified and saved. Future installs and proxy syncs will use these.',
    refresh: true,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'use_existing',
    label: 'Use existing password',
    description:
      'Saves the NPM admin email + password you already know works. ServiceBay verifies them against NPM before persisting, so a wrong entry can\'t lock you out further.',
    inputs: [
      {
        name: 'email',
        label: 'NPM admin email',
        type: 'email',
        placeholder: 'admin@example.com',
        required: true,
      },
      {
        name: 'password',
        label: 'NPM admin password',
        type: 'password',
        placeholder: 'The password you can log in with at NPM\'s admin UI',
        required: true,
      },
    ],
  },
  useExistingNpmCreds,
);

registerRefreshNow(PROBE_ID, CHECK_ID, 'NPM auth');
