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

import Mustache from 'mustache';
import type { VariableMeta } from '@/lib/registry';
import { buildCredentialsManifest, formatCredentialsBanner, type Credential } from './credentialsManifest';

/** Variable shape shared between wizard and modal. */
export interface StackVariable {
  name: string;
  value: string;
  global?: boolean;
  meta?: VariableMeta;
}

/** Selected stack item shape (subset, only what post-install needs). */
interface StackItem {
  name: string;
  checked: boolean;
}

/** Format elapsed milliseconds as `Mm Ss` for human-readable log lines. */
function fmtElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Wait for NPM to become reachable. Polls every 3s, heartbeat log every 30s. */
async function waitForNpm(
  node: string | undefined,
  onProgress: (msg: string) => void,
  maxWait = 60 * 60_000,
): Promise<boolean> {
  const start = Date.now();
  let lastBeat = 0;
  while (Date.now() - start < maxWait) {
    try {
      const query = node ? `?node=${node}` : '';
      const res = await fetch(`/api/system/nginx/status${query}`);
      if (res.ok) {
        const data = await res.json();
        if (data.installed && data.active) return true;
      }
    } catch { /* keep trying */ }
    const elapsed = Date.now() - start;
    // 10-second heartbeat — frequent enough that the user sees forward
    // motion without spamming the log on long waits.
    if (elapsed - lastBeat >= 10_000) {
      onProgress(`Still waiting for Nginx Proxy Manager (${fmtElapsed(elapsed)} elapsed)...`);
      lastBeat = elapsed;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

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
  const savedEscape = Mustache.escape;
  Mustache.escape = (text: string) => text;
  try {
    return {
      ...proxyConfig,
      advanced_config: Mustache.render(proxyConfig.advanced_config, view),
    };
  } finally {
    Mustache.escape = savedEscape;
  }
}

/** Build the proxy-host list from subdomain-typed variables. */
function buildProxyHosts(variables: StackVariable[]): {
  domain: string | undefined;
  hosts: { domain: string; forwardPort: number; service: string; proxyConfig?: VariableMeta['proxyConfig'] }[];
} {
  const domain = variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
  if (!domain) return { domain, hosts: [] };
  const view = variables.reduce<Record<string, string>>(
    (acc, v) => { acc[v.name] = v.value; return acc; },
    {},
  );
  const subdomainVars = variables.filter(v => v.meta?.type === 'subdomain' && v.value);
  const hosts = subdomainVars.map(sv => {
    let port = sv.meta?.proxyPort || '';
    const portVar = variables.find(v => v.name === port);
    if (portVar) port = portVar.value;
    const service = sv.meta?.templateName
      || sv.name.replace(/_SUBDOMAIN$/, '').toLowerCase();
    return {
      domain: `${sv.value}.${domain}`,
      forwardPort: parseInt(port, 10),
      service,
      proxyConfig: renderProxyConfig(sv.meta?.proxyConfig, view),
    };
  }).filter(h => Number.isFinite(h.forwardPort) && h.forwardPort > 0);
  return { domain, hosts };
}

export type ProxyResult = 'ok' | 'needs_credentials' | 'skipped' | 'error';

interface ConfigureProxyOpts {
  variables: StackVariable[];
  node?: string;
  onLog: (msg: string) => void;
  credentials?: { email: string; password: string };
  /** Skip the NPM-readiness wait (used when caller already waited). */
  skipWait?: boolean;
}

/** Configure NPM proxy hosts, returns 'needs_credentials' if NPM rejected
 *  the default/stored creds — caller is expected to prompt the user and
 *  call again with `credentials` set. */
export async function configureProxyRoutes(opts: ConfigureProxyOpts): Promise<ProxyResult> {
  const { variables, node, onLog, credentials, skipWait } = opts;
  const { domain, hosts } = buildProxyHosts(variables);
  if (!domain || hosts.length === 0) return 'skipped';

  if (!credentials && !skipWait) {
    onLog('Waiting for Nginx Proxy Manager to start (image pull / DB schema init can take a while)...');
    const ready = await waitForNpm(node, onLog);
    if (!ready) {
      onLog('⚠️ Nginx Proxy Manager not ready. Configure proxy routes manually in the NPM admin panel.');
      return 'skipped';
    }
    onLog('Configuring reverse proxy routes...');
  }

  try {
    const res = await fetch('/api/system/nginx/proxy-hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hosts,
        publicDomain: domain,
        node: node || undefined,
        ...(credentials ? { npmCredentials: credentials } : {}),
      }),
    });
    const data = await res.json();
    if (res.ok && data.created?.length) {
      onLog(`✅ Proxy routes created: ${data.created.join(', ')}`);
      if (data.failed?.length) {
        onLog(`⚠️ Some routes failed: ${data.failed.map((f: { domain: string }) => f.domain).join(', ')}`);
      }
      return 'ok';
    }
    if (res.status === 401 && data.needsCredentials) {
      onLog('⚠️ NPM default credentials did not work. Please enter your NPM admin credentials below.');
      return 'needs_credentials';
    }
    onLog(`⚠️ Proxy route error: ${data.error || 'unknown'}`);
    return 'error';
  } catch {
    onLog('⚠️ Could not reach Nginx Proxy Manager.');
    return 'error';
  }
}

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
async function bootstrapNpmAdmin(opts: {
  variables: StackVariable[];
  node?: string;
  onLog: (msg: string) => void;
}): Promise<'ok' | 'needs_credentials' | 'skipped'> {
  const email = opts.variables.find(v => v.name === 'NGINX_ADMIN_EMAIL')?.value;
  const password = opts.variables.find(v => v.name === 'NGINX_ADMIN_PASSWORD')?.value;
  const fullName = opts.variables.find(v => v.name === 'NGINX_ADMIN_NAME')?.value;
  if (!email || !password) return 'skipped';

  // The pod template sets INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD env
  // vars, so on first init NPM seeds the user table with these exact
  // credentials — but the seed step lands ~30-60 s after `/status` reports
  // the API is up. The bootstrap endpoint retries the target-creds login
  // for 90 s server-side; preview that to the operator so the wait isn't
  // a black box.
  opts.onLog('Verifying NPM admin credentials (waiting up to 90s for the user table to seed)...');

  try {
    const res = await fetch('/api/system/nginx/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, fullName, node: opts.node }),
    });
    const data = await res.json().catch(() => ({} as Record<string, unknown>));

    if (res.ok && data.ok && data.bootstrapped === true) {
      opts.onLog(`✅ NPM admin set to ${email} (default credentials disabled).`);
      return 'ok';
    }
    if (res.ok && data.ok && data.reason === 'already_using_target') {
      opts.onLog('✅ NPM admin already on the wizard credentials — nothing to do.');
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

interface RunPostInstallOpts {
  selected: StackItem[];
  variables: StackVariable[];
  node?: string;
  onLog: (msg: string) => void;
  /**
   * Credentials parsed from `__SB_CREDENTIAL__` markers a template's
   * post-deploy.py emitted on stdout. Appended to the SAVE-THESE-NOW
   * banner.
   */
  extraCredentials?: Credential[];
}

/** Orchestrate every post-install step. Returns the proxy-route status so
 *  the caller can decide whether to render the NPM-credential prompt.
 *
 *  Per-template seed/credential-surfacing logic runs as part of each
 *  service's post-deploy.py script during deploy (see ServiceManager.
 *  runPostDeployScript). This function only handles cross-template
 *  concerns: NPM bootstrap, proxy-host aggregation, and the final
 *  credentials banner. */
export async function runPostInstall(opts: RunPostInstallOpts): Promise<ProxyResult> {
  const { selected, variables, node, onLog, extraCredentials } = opts;
  const isSelected = (name: string) => selected.some(i => i.name === name);

  // NPM bootstrap is best-effort: if it fails we still want to run the
  // proxy-route step — the user can finish the NPM piece via the
  // credentials prompt.
  let npmBootstrap: 'ok' | 'needs_credentials' | 'skipped' = 'skipped';
  if (isSelected('nginx-web')) {
    // NPM cold-starts the SQLite schema after the container is ready, so the
    // very first /api/tokens call sometimes 502s. Wait until it's reachable
    // before bootstrapping; configureProxyRoutes below would do the same wait
    // anyway, just less informatively.
    onLog('Waiting for Nginx Proxy Manager to start (image pull / DB schema init can take a while)...');
    await waitForNpm(node, onLog);
    npmBootstrap = await bootstrapNpmAdmin({ variables, node, onLog });
  }

  // If we just bootstrapped NPM (or determined it's locked to other creds),
  // we already waited for it to be reachable — skip the second wait inside
  // configureProxyRoutes so the install log doesn't repeat the heartbeat.
  const proxyResult = await configureProxyRoutes({
    variables,
    node,
    onLog,
    skipWait: npmBootstrap !== 'skipped',
  });

  // Final banner — one block collecting every credential the user may need
  // to remember. Built from `__SB_CREDENTIAL__` markers each template's
  // post-deploy.py emitted plus the variable-driven OIDC entries derived
  // from variables[].meta.oidcClient.
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const manifest = [
    ...buildCredentialsManifest({ variables, host }),
    ...(extraCredentials ?? []),
  ];
  formatCredentialsBanner(manifest).forEach(onLog);

  return proxyResult;
}
