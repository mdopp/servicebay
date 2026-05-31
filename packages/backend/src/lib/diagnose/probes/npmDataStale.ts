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
import { generateRandomSecret } from '@/lib/stackInstall/randomSecret';

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
  const failure = await verifyNpmCreds(adminUrl, email, password);
  if (failure) return failure;
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

/**
 * POST the given admin creds to NPM's /api/tokens to confirm they work, without
 * persisting. Returns a failure ProbeActionResult, or null when NPM accepts
 * them. Extracted from useExistingNpmCreds to keep it under the line limit.
 */
async function verifyNpmCreds(
  adminUrl: string,
  email: string,
  password: string,
): Promise<ProbeActionResult | null> {
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
  return null;
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

// ─── Non-destructive auto re-key (credential-reconciliation, inc. 2) ─────
//
// The third recovery path, and the one for the most common reinstall
// case: NPM's DB persisted from a prior install with an admin password
// ServiceBay no longer knows (its stored one went empty/diverged). Unlike
// `use_existing` (needs the operator to KNOW the password) and
// `reset_volume` (wipes all proxy hosts), this re-keys NPM's admin to a
// fresh generated password IN PLACE — keeping every proxy route — by
// rewriting the bcrypt hash directly in NPM's SQLite, then persisting the
// new password. An admin login secret isn't an encryption key, so this is
// safe to do silently (the "auto-rekey when safe" path).
//
// Run inside the NPM container so we use NPM's own bundled bcrypt (cost
// 13, matching the `$2b$13$` hashes it writes) + better-sqlite3, and
// operate on the container-relative /data/database.sqlite — robust to the
// host data-dir name. Validated live before shipping.
const NPM_REKEY_JS = [
  "const bcrypt=require('/app/node_modules/bcrypt');",
  "const Database=require('/app/node_modules/better-sqlite3');",
  "const db=Database('/data/database.sqlite');",
  "const u=db.prepare(\"SELECT id,email FROM user WHERE is_deleted=0 ORDER BY id LIMIT 1\").get();",
  "if(!u){process.stdout.write('noadmin');process.exit(0);}",
  "const hash=bcrypt.hashSync(process.env.NEWPW,13);",
  "const r=db.prepare(\"UPDATE auth SET secret=?, modified_on=datetime('now') WHERE user_id=? AND type='password'\").run(hash,u.id);",
  "process.stdout.write('email='+u.email+';updated='+r.changes);",
].join('\n');

async function rekeyNpmAdmin({ node }: { node: string }): Promise<ProbeActionResult> {
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) {
    return { ok: false, message: 'Nginx Proxy Manager is not deployed/active on this node — nothing to re-key.', refresh: false };
  }
  const agent = await agentManager.ensureAgent(node);
  // Locate the running NPM container (jc21 image) to exec into.
  const find = await agent.sendCommand('exec', {
    command: `podman ps --format '{{.Names}} {{.Image}}' | awk '/proxy-manager/{print $1; exit}'`,
  }, { timeoutMs: 15_000 });
  const container = ((find as { stdout?: string }).stdout || '').trim().split(/\s+/)[0];
  if (!container) {
    return { ok: false, message: 'Could not find the running NPM container to re-key.', refresh: false };
  }
  const newPassword = generateRandomSecret(32);
  const b64 = Buffer.from(NPM_REKEY_JS).toString('base64');
  // base64 the script in to avoid quoting hell; password via env, never on argv.
  const rewrite = await agent.sendCommand('exec', {
    command: `echo ${b64} | base64 -d | podman exec -i -e NEWPW=${newPassword} ${container} node -`,
  }, { timeoutMs: 30_000 });
  const out = ((rewrite as { stdout?: string }).stdout || '').trim();
  const m = out.match(/email=(.*);updated=(\d+)/);
  if ((rewrite as { code?: number }).code !== 0 || !m || m[2] === '0') {
    return {
      ok: false,
      message: `Could not re-key the NPM admin password: ${(rewrite as { stderr?: string }).stderr || out || 'unknown error'}`,
      refresh: false,
    };
  }
  const email = m[1];
  // Prove the new password works before persisting — never store creds we can't verify.
  const failure = await verifyNpmCreds(adminUrl, email, newPassword);
  if (failure) return failure;
  await updateConfig({ reverseProxy: { npm: { email, password: newPassword } } });
  logger.info('diagnose:npm_data_stale', `Re-keyed NPM admin password for ${email} (non-destructive; proxy hosts preserved)`);
  return {
    ok: true,
    message: 'NPM admin password re-keyed and saved — all proxy routes were preserved. ServiceBay can manage NPM again.',
    refresh: true,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'rekey_admin',
    label: 'Re-key NPM admin (keep data)',
    description:
      "Generates a fresh NPM admin password, writes it straight into NPM's database, and saves it — WITHOUT wiping any proxy routes. The no-data-loss fix for when the stored password no longer works and you don't know the current one.",
  },
  rekeyNpmAdmin,
);

registerRefreshNow(PROBE_ID, CHECK_ID, 'NPM auth');
