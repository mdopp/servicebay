/**
 * `npm_data_stale` probe — detects when Nginx Proxy Manager has rejected
 * the credentials ServiceBay has stored / auto-generated for it. Most
 * common cause: a previous install left an admin password in NPM's
 * SQLite database that no longer matches the wizard's expected one
 * (the volume survived a reinstall / restore).
 *
 * Without this probe the symptom is silent: proxy-host creation 401s
 * once at install time, the wizard prompts for credentials, and from
 * then on every install/redeploy hits the same wall. With it the
 * operator sees a single fix-button on the diagnose page.
 *
 * Detection: try POST /api/tokens against the local NPM admin URL with
 * the stored credentials. 401 → stale. 5xx / connection failure → NPM
 * is just down (don't surface this probe; the existing pods/units
 * probes already cover that).
 *
 * Action `reset_volume` (destructive) wipes NPM's data dir and restarts
 * the service so it re-seeds with the wizard's INITIAL_ADMIN_*
 * credentials. Action `use_existing` (non-destructive) accepts the
 * password the operator knows works and persists it to config — no
 * data loss, the right path for "I already changed the password
 * outside the wizard."
 */

import { agentManager } from '@/lib/agent/manager';
import { getConfig, updateConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult } from '../actions';

export interface NpmDataStaleResult {
  /** undefined when not applicable (no nginx-web, or NPM not reachable). */
  status?: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
}

/** Locate the running nginx-web service on `node` and return its admin URL.
 *  Returns null when nginx-web isn't installed or its admin port can't
 *  be derived from the service manifest. */
async function findNpmAdminUrl(node: string): Promise<string | null> {
  try {
    const services = await ServiceManager.listServices(node);
    const nginx = services.find(
      s => s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
    );
    if (!nginx?.active) return null;
    // Admin port is the published host port that isn't 80 or 443.
    const ports = (nginx.ports ?? [])
      .map(p => parseInt(String(p.host ?? ''), 10))
      .filter(p => Number.isFinite(p) && p !== 80 && p !== 443);
    const adminPort = ports[0] ?? 81;
    return `http://localhost:${adminPort}`;
  } catch {
    return null;
  }
}

/** Run the detection. Returns a partial probe payload — diagnose route
 *  glues on the id/label/actions from the registry. */
export async function checkNpmDataStale(node: string): Promise<NpmDataStaleResult> {
  const config = await getConfig();
  const npm = config.reverseProxy?.npm;
  if (!npm?.email || !npm?.password) {
    // No stored creds — nothing to check. Skip with info status.
    return {
      status: 'info',
      detail: 'No NPM admin credentials stored — skipping staleness check.',
    };
  }
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) {
    return {
      status: 'info',
      detail: 'Nginx Proxy Manager not deployed on this node — nothing to check.',
    };
  }

  // Authenticate with stored creds. 401 → stale; everything else (200,
  // 5xx, network error) we treat as "not stale-with-confidence" and
  // surface info-only — the existing pods/units probes already handle
  // "NPM is down" cases.
  try {
    const res = await fetch(`${adminUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: npm.email, secret: npm.password }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      return { status: 'ok', detail: 'NPM accepts the stored admin credentials.' };
    }
    if (res.status === 401) {
      return {
        status: 'fail',
        detail:
          'Nginx Proxy Manager is rejecting the stored admin credentials. This usually means a previous install left an admin password in the NPM database that no longer matches.',
        hint: 'If you know the password NPM is actually using, click "Use existing password" below to save it (no data loss). Otherwise "Reset NPM data" wipes the database and re-seeds with the wizard credentials.',
      };
    }
    return {
      status: 'info',
      detail: `NPM auth probe returned HTTP ${res.status} — assuming transient.`,
    };
  } catch (e) {
    return {
      status: 'info',
      detail: `Could not reach NPM at ${adminUrl}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

const PROBE_ID = 'npm_data_stale';

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
