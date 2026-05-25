/**
 * Shared post-install pipeline for stack deployments.
 *
 * Both OnboardingWizard and InstallerModal call into this module after the
 * services have been deployed via /api/services. Centralizing it here keeps
 * the two install entry points behaviourally identical — every change lands
 * once and applies to both flows.
 *
 * Per-template glue (credential surfacing, admin seeding, etc.) lives in
 * each template's `post-deploy.py` script. The engine only keeps logic
 * that genuinely needs core access:
 *   - NPM bootstrap (returns a tri-state used by the wizard credential
 *     prompt — a script can't cleanly express that)
 *   - Cross-template proxy-host aggregation (walks subdomain-typed vars
 *     across every selected template)
 *
 * The `tests/backend/template_consistency.test.ts` "no unauthorized
 * per-template branches" rule guards this boundary — adding a new
 * isSelected call with a template-name literal is a build failure
 * unless added to the test's ALLOWED list with a justifying comment.
 *
 * The functions are UI-agnostic: state mutation is funnelled through the
 * `onLog` / `onNpmCredentialsNeeded` callbacks so the caller can render
 * however it likes.
 */

import { renderTemplate } from '../template/render';
import type { VariableMeta } from '@/lib/registry';
import { expandForwardAuthSentinel } from './forwardAuth';
import { getInternalApiToken } from '@/lib/auth/internalToken';
import { getConfig } from '@/lib/config';

/** Loopback fetch helper. The post-install pipeline runs server-side
 *  inside the install runner; this file is no longer pulled into the
 *  client bundle (only its types are). proxy.ts middleware blocks plain
 *  Node-fetch POSTs as cross-site (no Origin header), so we attach the
 *  internal token to every call. */
function apiFetch(p: string, init?: RequestInit): Promise<Response> {
  const port = process.env.PORT || '3000';
  const headers = new Headers(init?.headers);
  if (!headers.has('x-sb-internal-token')) {
    headers.set('x-sb-internal-token', getInternalApiToken());
  }
  return fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers });
}

/** Variable shape shared between wizard and modal. */
// StackVariable lives in `./types.ts` (#601 cycle-break) — re-exported
// so existing consumers don't need to change imports.
export { type StackVariable } from './types';
import type { StackVariable } from './types';

// #632 removed `waitForNpm` — the /api/system/nginx/bootstrap endpoint
// already retries the target-creds login for 90s server-side, which
// subsumes the pre-call reachability poll. NPM-startup waiting now
// happens inside the bootstrap endpoint.

/**
 * Render Mustache placeholders inside an NPM proxyConfig (mainly the
 * `advanced_config` block, which references things like `{{PUBLIC_DOMAIN}}`
 * and `{{AUTHELIA_PORT}}` for cross-template wiring). Without this step the
 * placeholders are forwarded to NPM verbatim and any SSO snippet that points
 * at another stack template silently 404s.
 */
function renderProxyConfig(
  proxyConfig: VariableMeta['proxyConfig'] | undefined,
  view: Record<string, string>,
): VariableMeta['proxyConfig'] | undefined {
  if (!proxyConfig) return proxyConfig;
  if (!proxyConfig.advanced_config) return proxyConfig;
  // Expand the `__authelia_forward_auth__` sentinel into the shared
  // nginx snippet before the Mustache pass so the snippet's own
  // {{PUBLIC_DOMAIN}} / {{AUTHELIA_PORT}} placeholders still get
  // substituted from `view`.
  const expanded = expandForwardAuthSentinel(proxyConfig.advanced_config) ?? proxyConfig.advanced_config;
  return {
    ...proxyConfig,
    advanced_config: renderTemplate(expanded, view),
  };
}

/** Build the proxy-host list from subdomain-typed variables. Exported
 * for unit testing — the public-vs-LAN routing rule is subtle enough
 * that a regression test is worth pinning (see
 * `tests/backend/buildProxyHosts.test.ts`).
 *
 * Hosts are split by their declared `exposure`:
 *   - `public`   → `<sub>.<PUBLIC_DOMAIN>` (Let's Encrypt cert,
 *     externally reachable once DNS points here).
 *   - `internal` → `<sub>.<PUBLIC_DOMAIN>` (LE cert too, so Authelia
 *     forward-auth works) but the proxy host binds the NPM LAN-only
 *     access list. ACME-challenge bypasses the allowlist by design.
 *   - `lan`      → `<sub>.<PUBLIC_DOMAIN>` too, no cert. Split-horizon
 *     is enforced by AdGuard's `*.<PUBLIC_DOMAIN> → <lanIp>` wildcard
 *     plus the absence of a public DNS record for LAN-only names.
 *
 * Pure LAN-only installs (no `PUBLIC_DOMAIN` set) get `<sub>.home.arpa`
 * as the only sensible answer — they have nothing to graft onto.
 */
export function buildProxyHosts(variables: StackVariable[]): {
  domain: string | undefined;
  hosts: {
    domain: string;
    forwardPort: number;
    service: string;
    /** 'public' and 'internal' trigger auto-cert; 'lan' skips. */
    exposure: 'public' | 'internal' | 'lan';
    proxyConfig?: VariableMeta['proxyConfig'];
    /** Target the proxy host forwards to. Defaults (when omitted by
     *  the proxy-host route) to the node's LAN IP — correct for
     *  services binding 0.0.0.0 or the LAN interface. Loopback-bound
     *  services (Syncthing's GUI, etc.) need this set to
     *  `host.containers.internal` so NPM (in a container) can reach
     *  the host's loopback. (#880) */
    forwardHost?: string;
  }[];
} {
  const domain = variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
  const lanDomain = domain || 'home.arpa';
  const view = variables.reduce<Record<string, string>>(
    (acc, v) => { acc[v.name] = v.value; return acc; },
    {},
  );
  const subdomainVars = variables.filter(v => v.meta?.type === 'subdomain' && v.value);
  const hosts = subdomainVars.flatMap(sv => {
    // Conservative default: missing/unknown → 'lan'. Templates declare
    // `"exposure": "public"` or `"internal"` explicitly when they want
    // a cert at install time.
    const raw = sv.meta?.exposure;
    const exposure: 'public' | 'internal' | 'lan' =
      raw === 'public' ? 'public'
      : raw === 'internal' ? 'internal'
      : 'lan';
    const hostDomain = (exposure === 'public' || exposure === 'internal') ? domain : lanDomain;
    if (!hostDomain) return [];
    let port = sv.meta?.proxyPort || '';
    const portVar = variables.find(v => v.name === port);
    if (portVar) port = portVar.value;
    const service = sv.meta?.templateName
      || sv.name.replace(/_SUBDOMAIN$/, '').toLowerCase();
    return [{
      domain: `${sv.value}.${hostDomain}`,
      forwardPort: parseInt(port, 10),
      service,
      exposure,
      proxyConfig: renderProxyConfig(sv.meta?.proxyConfig, view),
      // Loopback-bound services (Syncthing GUI etc.) bind to the host's
      // 127.0.0.1. NPM today runs `hostNetwork: true` so it shares the
      // host netns and `127.0.0.1` IS the right forward target. When
      // #817 eventually moves NPM into its own netns, this needs to
      // become `host.containers.internal` instead. (#880)
      ...(sv.meta?.loopbackOnly ? { forwardHost: '127.0.0.1' } : {}),
    }];
  }).filter(h => Number.isFinite(h.forwardPort) && h.forwardPort > 0);
  return { domain, hosts };
}

// #632 removed `configureProxyRoutes` — the nginx capability handler
// now creates proxy hosts per-template via the same /api/system/nginx/
// proxy-hosts endpoint, with the cert + lan-restriction + forward-auth
// logic unchanged on the server side.

/** Bootstrap a freshly-deployed NPM: log it in with built-in defaults
 *  (admin@example.com / changeme), apply the wizard's chosen email + password
 *  via NPM's REST API, then persist them on our side. NPM does not read env
 *  vars for admin credentials — without this step it stays on defaults forever
 *  and our subsequent proxy-host calls authenticate against credentials NPM
 *  has never heard of, surfacing the dreaded "NPM Admin Login" prompt.
 *
 *  Idempotent: if NPM already accepts the target credentials, the endpoint
 *  short-circuits to "already_using_target" and we just persist locally.
 *  If NPM is locked to something else (stale data volume), we report the
 *  problem so the caller can hand control to the user.
 *
 *  This stays in the engine (rather than nginx-web/post-deploy.py) because
 *  the tri-state result drives the wizard's NPM-credentials prompt UI. */
export async function bootstrapNpmAdmin(opts: {
  variables: StackVariable[];
  node?: string;
  onLog: (msg: string) => void;
  /**
   * Distinguishes the initial bootstrap call from a post-self-heal retry
   * (#733). On retry the data dir has just been wiped + nginx restarted,
   * so the user table seeds within ~10s — there's no need to display
   * the same "up to 90s" preamble, and the success log line for an
   * `already_using_target` outcome is misleading (the previous bootstrap
   * *did* do work; only this call short-circuited). Use `'retry'` from
   * the install runner's self-heal branch.
   */
  phase?: 'initial' | 'retry';
}): Promise<'ok' | 'needs_credentials' | 'skipped'> {
  const email = opts.variables.find(v => v.name === 'NGINX_ADMIN_EMAIL')?.value;
  const password = opts.variables.find(v => v.name === 'NGINX_ADMIN_PASSWORD')?.value;
  const fullName = opts.variables.find(v => v.name === 'NGINX_ADMIN_NAME')?.value;
  if (!email || !password) return 'skipped';

  const isRetry = opts.phase === 'retry';

  // The pod template sets INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD env
  // vars, so on first init NPM seeds the user table with these exact
  // credentials — but the seed step lands ~30-60 s after `/status` reports
  // the API is up. The bootstrap endpoint retries the target-creds login
  // for ~90 s on the initial call, ~20 s on a self-heal retry (#733):
  // by the time we get to the retry the data dir has been wiped + nginx
  // was restarted ~30 s ago, so the seed should land within seconds.
  if (isRetry) {
    opts.onLog('Re-verifying NPM admin credentials after self-heal (waiting up to 20s)...');
  } else {
    opts.onLog('Verifying NPM admin credentials (waiting up to 90s for the user table to seed)...');
  }

  try {
    const res = await apiFetch('/api/system/nginx/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, fullName, node: opts.node, quickRetry: isRetry }),
    });
    const data = await res.json().catch(() => ({} as Record<string, unknown>));

    if (res.ok && data.ok && data.bootstrapped === true) {
      opts.onLog(`✅ NPM admin set to ${email} (default credentials disabled).`);
      return 'ok';
    }
    if (res.ok && data.ok && data.reason === 'already_using_target') {
      // After a self-heal the data dir was just freshly seeded — the
      // "nothing to do" framing reads like the retry no-op'd, which is
      // confusing immediately after the "Wiping NPM data/" log line.
      // Phrase the same outcome in terms of what just happened (#733).
      if (isRetry) {
        opts.onLog(`✅ NPM bootstrap fresh on wizard credentials (${email}).`);
      } else {
        opts.onLog('✅ NPM admin already on the wizard credentials — nothing to do.');
      }
      return 'ok';
    }
    if (res.ok && data.ok && data.reason === 'using_saved') {
      // The wizard's new password was rejected, but the credentials we
      // already had stored still work. Override the in-memory wizard
      // variables so subsequent proxy-host calls authenticate with the
      // password NPM actually accepts — otherwise we'd be back to 401s
      // immediately after this success log.
      const cfg = await getConfig();
      const saved = cfg.reverseProxy?.npm;
      if (saved?.email && saved?.password) {
        for (const v of opts.variables) {
          if (v.name === 'NGINX_ADMIN_EMAIL') v.value = saved.email;
          if (v.name === 'NGINX_ADMIN_PASSWORD') v.value = saved.password;
        }
        opts.onLog(`✅ Reusing existing NPM admin (${saved.email}) — the wizard's new password was not applied.`);
      } else {
        opts.onLog('✅ NPM already has admin credentials — keeping them.');
      }
      return 'ok';
    }
    if (res.ok && data.ok && data.reason === 'defaults_rejected') {
      // Server includes a `detail` string with the most likely cause from
      // its perspective (90 s retry exhausted, defaults also rejected).
      const detail = typeof data.detail === 'string' ? data.detail : 'NPM did not accept the wizard credentials and is not on legacy defaults.';
      opts.onLog(`⚠️ ${detail}`);
      return 'needs_credentials';
    }
    opts.onLog(`⚠️ NPM bootstrap failed: ${typeof data.error === 'string' ? data.error : `HTTP ${res.status}`}. You may need to set NPM credentials manually in Settings → Integrations.`);
    return 'needs_credentials';
  } catch (e) {
    opts.onLog(`⚠️ Could not reach the NPM bootstrap endpoint: ${e instanceof Error ? e.message : String(e)}`);
    return 'needs_credentials';
  }
}

// #632 removed `runPostInstall` (the bulk orchestrator that called
// `configureProxyRoutes` + `registerOidcClients` + manifest persist).
// The install runner now drives each step itself: `bootstrapNpmAdmin`
// for NPM bootstrap, `bus.emit('feature.installed', ...)` per template
// for OIDC + proxy hosts + DNS rewrites + credentials manifest. The
// helpers below stay exported for diagnose / portal-provisioner reuse.
