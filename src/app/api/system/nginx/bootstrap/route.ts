import { NextResponse } from 'next/server';
import { getConfig, updateConfig } from '@/lib/config';
import { DigitalTwinStore } from '@/lib/store/twin';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { agentManager } from '@/lib/agent/manager';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';

/** Touch the install-nginx-done marker so the FCoS first-boot
 *  install-nginx.service unit's ConditionPathExists short-circuits on the
 *  next boot. Called whenever we've confirmed NPM is up + reachable on the
 *  wizard credentials — at that point the install-nginx.sh fallback has
 *  nothing left to do, and leaving the unit's `failed` state lingering only
 *  produces noise in the diagnose probe. Best-effort; if the agent isn't
 *  reachable yet (it should be — we just talked to NPM through it) we just
 *  swallow the error and let the install-nginx.sh trap handle it on next
 *  boot. */
async function markInstallNginxDone(nodeName: string): Promise<void> {
  try {
    const agent = await agentManager.ensureAgent(nodeName);
    await agent.sendCommand('exec', {
      command: 'mkdir -p ~/.config && touch ~/.config/install-nginx-done && systemctl --user reset-failed install-nginx.service 2>/dev/null || true',
    });
  } catch (e) {
    logger.debug('npm:bootstrap', 'Could not mark install-nginx-done:', e);
  }
}

export const dynamic = 'force-dynamic';

/**
 * Bootstrap a fresh Nginx Proxy Manager instance: log in with NPM's built-in
 * default credentials (admin@example.com / changeme), update user #1 to the
 * caller-supplied email + password, then persist the new credentials so the
 * rest of ServiceBay (proxy-host creation, future syncs) can authenticate.
 *
 * Why this exists: NPM does not read env vars for admin credentials. It ships
 * with the well-known defaults and requires a one-time API login + password
 * change to lock them down. The OnboardingWizard previously skipped this
 * step, persisting the wizard's *aspirational* random credentials in
 * ServiceBay's config without ever telling NPM about them. Subsequent proxy
 * calls then 401'd and surfaced the "NPM Admin Login" prompt to the user.
 *
 * Request body:
 *   { node?: string; email: string; password: string; fullName?: string }
 *
 * Response:
 *   { ok: true,  bootstrapped: true }                     – defaults applied
 *   { ok: true,  bootstrapped: false, reason: 'already_using_target' }
 *                                                          – idempotent retry
 *   { ok: true,  bootstrapped: false, reason: 'using_saved' }
 *                                                          – wizard creds
 *                                                            rejected, but
 *                                                            config.reverseProxy.
 *                                                            npm still matches
 *                                                            NPM's DB (preserved
 *                                                            across reinstall) –
 *                                                            silently keep them
 *   { ok: true,  bootstrapped: false, reason: 'defaults_rejected' }
 *                                                          – NPM is locked to
 *                                                            something else
 *                                                            (stale data
 *                                                            volume) – user
 *                                                            must enter creds
 *   { ok: false, error: '…', status: <http> }              – fatal
 */
const NPM_DEFAULT_EMAIL = 'admin@example.com';
const NPM_DEFAULT_PASSWORD = 'changeme';

interface NpmResolution {
  apiUrl: string;
  nodeName: string;
}

function getNodeIp(nodeName: string, twinStore: DigitalTwinStore): string {
  const twin = twinStore.nodes[nodeName];
  if (twin?.nodeIPs?.length) {
    const lanIp = twin.nodeIPs.find(ip => !ip.startsWith('127.'));
    if (lanIp) return lanIp;
    return twin.nodeIPs[0];
  }
  return '127.0.0.1';
}

async function resolveNpm(nodeHint?: string): Promise<NpmResolution | null> {
  const twinStore = DigitalTwinStore.getInstance();
  const nodeNames = nodeHint ? [nodeHint] : Object.keys(twinStore.nodes);
  if (nodeNames.length === 0) nodeNames.push('Local');

  for (const nodeName of nodeNames) {
    const services = await ServiceManager.listServices(nodeName);
    const nginxService = services.find(s =>
      s.name === 'nginx' ||
      (s.name.includes('nginx') && !s.name.startsWith('install-'))
    );
    if (!nginxService?.active) continue;

    const svc = nginxService as { ports?: { containerPort?: number; hostPort?: number }[] };
    const adminMapping = svc.ports?.find(p => p.containerPort === 81);
    let adminPort = adminMapping?.hostPort?.toString();
    if (!adminPort) {
      const config = await getConfig();
      adminPort = config.templateSettings?.NGINX_ADMIN_PORT || '81';
    }
    const apiHost = nodeName === 'Local' ? '127.0.0.1' : getNodeIp(nodeName, twinStore);
    return { apiUrl: `http://${apiHost}:${adminPort}`, nodeName };
  }
  return null;
}

async function npmLogin(baseUrl: string, identity: string, secret: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity, secret }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.token === 'string' ? data.token : null;
  } catch {
    return null;
  }
}

async function npmUpdateUser(baseUrl: string, token: string, payload: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${baseUrl}/api/users/1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NPM PUT /api/users/1 failed (${res.status}): ${body || 'no body'}`);
  }
}

async function npmUpdatePassword(baseUrl: string, token: string, current: string, secret: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/users/1/auth`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ type: 'password', current, secret }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`NPM PUT /api/users/1/auth failed (${res.status}): ${body || 'no body'}`);
  }
}

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json() as {
      node?: string;
      email?: string;
      password?: string;
      fullName?: string;
    };
    const { node, email, password, fullName } = body;

    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
      return NextResponse.json({ ok: false, error: 'email and password are required' }, { status: 400 });
    }

    const npm = await resolveNpm(node);
    if (!npm) {
      return NextResponse.json({ ok: false, error: 'Nginx Proxy Manager not found or not running' }, { status: 404 });
    }

    // The nginx pod sets INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD
    // env vars, which NPM honours on first init: it seeds the admin user
    // with the wizard's chosen credentials, NOT admin@example.com/changeme.
    // So the happy path on a fresh install is "wait for NPM to finish
    // seeding the user table, then target creds work directly". The DB
    // schema migrations + user seed reliably take 30-60 s after the API
    // first reports "running" — so retry for 90 s before giving up.
    //
    // The defaults fallback below remains as a safety net for older NPM
    // versions that ignored the INITIAL_ADMIN_* env vars, or for installs
    // that somehow lost them.
    const TARGET_RETRY_BUDGET_MS = 90_000;
    const RETRY_INTERVAL_MS = 3_000;
    const start = Date.now();
    let targetToken: string | null = null;
    while (Date.now() - start < TARGET_RETRY_BUDGET_MS) {
      targetToken = await npmLogin(npm.apiUrl, email, password);
      if (targetToken) break;
      await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
    }
    if (targetToken) {
      const config = await getConfig();
      await updateConfig({ reverseProxy: { ...config.reverseProxy, npm: { email, password } } });
      await markInstallNginxDone(npm.nodeName);
      return NextResponse.json({ ok: true, bootstrapped: false, reason: 'already_using_target' });
    }

    // Target creds didn't work even after waiting. Fall back to NPM's
    // pre-INITIAL_ADMIN built-in defaults. This succeeds only on legacy
    // NPM versions or on installs whose data volume was preserved while
    // the env vars in the new pod manifest don't match the existing user.
    const defaultsToken = await npmLogin(npm.apiUrl, NPM_DEFAULT_EMAIL, NPM_DEFAULT_PASSWORD);
    if (!defaultsToken) {
      // Last resort before surfacing a prompt: try the credentials we
      // already have persisted in config.reverseProxy.npm. On a reinstall
      // where the NPM data volume was preserved (default for the `certs`
      // group), NPM's bcrypt hash still matches the *previous* install's
      // password — which is exactly what's in config because
      // updateConfig() ran the last time NPM bootstrapped. Reusing them
      // silently here avoids dragging the operator through a credentials
      // prompt that pre-fills with a password (the new wizard one) that
      // NPM has already rejected and never will accept.
      const savedNpm = (await getConfig()).reverseProxy?.npm;
      if (savedNpm?.email && savedNpm?.password &&
          (savedNpm.email !== email || savedNpm.password !== password)) {
        const savedToken = await npmLogin(npm.apiUrl, savedNpm.email, savedNpm.password);
        if (savedToken) {
          await markInstallNginxDone(npm.nodeName);
          return NextResponse.json({
            ok: true,
            bootstrapped: false,
            reason: 'using_saved',
            detail: `NPM rejected the wizard's new credentials but still accepts the previously-saved ones (${savedNpm.email}) — keeping them. The wizard's new password was not applied.`,
          });
        }
      }
      return NextResponse.json({
        ok: true,
        bootstrapped: false,
        reason: 'defaults_rejected',
        // Caller renders this verbatim; honest about the most likely cause.
        detail: `NPM did not accept the wizard's INITIAL_ADMIN_* credentials within ${TARGET_RETRY_BUDGET_MS / 1000}s, and the legacy admin@example.com fallback was also rejected. Most likely the data volume holds an admin password from a previous install — reset NPM's data dir, or paste the existing password into the prompt.`,
      });
    }

    // Order matters: change user fields first (email is the login identity),
    // then change the password using the *defaults* `current`. NPM rotates
    // the token on email change, but the existing token stays valid for this
    // request stream — the next /api/tokens call will get a new one.
    const name = fullName || email.split('@')[0] || 'admin';
    await npmUpdateUser(npm.apiUrl, defaultsToken, {
      name,
      nickname: name,
      email,
      roles: ['admin'],
      is_disabled: false,
    });
    await npmUpdatePassword(npm.apiUrl, defaultsToken, NPM_DEFAULT_PASSWORD, password);

    // Verify by re-logging in with the new creds before persisting. If this
    // fails the NPM bootstrap is in a bad state and the user needs to know.
    const verifyToken = await npmLogin(npm.apiUrl, email, password);
    if (!verifyToken) {
      return NextResponse.json({
        ok: false,
        error: 'NPM accepted the credential change but rejected the new credentials on re-login',
      }, { status: 500 });
    }

    const config = await getConfig();
    await updateConfig({ reverseProxy: { ...config.reverseProxy, npm: { email, password } } });
    await markInstallNginxDone(npm.nodeName);

    logger.info('npm:bootstrap', `NPM admin updated to ${email} on node ${npm.nodeName}`);
    return NextResponse.json({ ok: true, bootstrapped: true });
  } catch (e) {
    return apiError(e, { tag: 'api:system:nginx:bootstrap', status: 500 });
  }
}
