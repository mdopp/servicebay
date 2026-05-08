/**
 * Shared post-install pipeline for stack deployments.
 *
 * Both OnboardingWizard and InstallerModal call into this module after the
 * services have been deployed via /api/services. Centralizing it here keeps
 * the two install entry points behaviourally identical — every change lands
 * once and applies to both flows.
 *
 * The functions are UI-agnostic: state mutation is funnelled through the
 * `onLog` / `onNpmCredentialsNeeded` callbacks so the caller can render
 * however it likes.
 */

import Mustache from 'mustache';
import type { VariableMeta } from '@/lib/registry';
import { buildCredentialsManifest, formatCredentialsBanner } from './credentialsManifest';

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

/** Wait for LLDAP HTTP+API to be reachable. Same heartbeat pattern. */
async function waitForLldap(
  host: string,
  port: number,
  onProgress: (msg: string) => void,
  maxWait = 10 * 60_000,
): Promise<boolean> {
  const start = Date.now();
  let lastBeat = 0;
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch('/api/system/lldap/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host, port }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.reachable) return true;
      }
    } catch { /* keep trying */ }
    const elapsed = Date.now() - start;
    if (elapsed - lastBeat >= 10_000) {
      onProgress(`Still waiting for LLDAP (${fmtElapsed(elapsed)} elapsed)...`);
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
  hosts: { domain: string; forwardPort: number; service: string; proxyConfig?: unknown }[];
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
    const service = sv.name.replace(/_SUBDOMAIN$/, '').toLowerCase().replace(/^ha$/, 'home-assistant');
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

interface PersistLldapCredsOpts {
  variables: StackVariable[];
  onLog: (msg: string) => void;
}

/** Persist LLDAP admin credentials and log them once for the user. */
async function persistLldapCredentials(opts: PersistLldapCredsOpts): Promise<void> {
  const password = opts.variables.find(v => v.name === 'LLDAP_ADMIN_PASSWORD')?.value;
  const port = opts.variables.find(v => v.name === 'LLDAP_PORT')?.value || '17170';
  if (!password) return;
  try {
    await fetch('/api/system/lldap/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `http://localhost:${port}`,
        username: 'admin',
        password,
      }),
    });
    opts.onLog(`🔑 LLDAP admin (user: admin, password: ${password}) — open http://<server-ip>:${port} or via NPM. Stored in Settings → Integrations.`);
  } catch {
    opts.onLog(`⚠️ Could not persist LLDAP credentials. Note now: admin / ${password}`);
  }
}

/** Just log AdGuard credentials once — config is already pre-seeded into
 *  AdGuardHome.yaml by the wizard's mustache step. */
function logAdguardCredentials(opts: { variables: StackVariable[]; onLog: (msg: string) => void }): void {
  const user = opts.variables.find(v => v.name === 'ADGUARD_ADMIN_USER')?.value || 'admin';
  const password = opts.variables.find(v => v.name === 'ADGUARD_ADMIN_PASSWORD')?.value;
  const port = opts.variables.find(v => v.name === 'ADGUARD_ADMIN_PORT')?.value || '8083';
  if (!password) return;
  opts.onLog(`🔑 AdGuard admin (user: ${user}, password: ${password}) — open http://<server-ip>:${port}. Note now, only shown once.`);
}

function logAudiobookshelfCredentials(opts: { variables: StackVariable[]; onLog: (msg: string) => void }): void {
  const user = opts.variables.find(v => v.name === 'ABS_ADMIN_USER')?.value || 'root';
  const password = opts.variables.find(v => v.name === 'ABS_ADMIN_PASSWORD')?.value;
  const port = opts.variables.find(v => v.name === 'ABS_PORT')?.value || '13378';
  if (!password) return;
  opts.onLog(`🔑 Audiobookshelf admin (user: ${user}, password: ${password}) — open http://<server-ip>:${port}. Note now, only shown once.`);
}

function logFileShareCredentials(opts: { variables: StackVariable[]; onLog: (msg: string) => void }): void {
  const user = opts.variables.find(v => v.name === 'SHARE_USER')?.value || 'samba';
  const password = opts.variables.find(v => v.name === 'SHARE_PASSWORD')?.value;
  if (!password) return;
  opts.onLog(`🔑 Samba share (user: ${user}, password: ${password}) — mount via \\\\<server-ip>\\data on Windows or smb://<server-ip>/data on macOS. Note now, only shown once.`);
}

/** Surface OIDC client secrets that the user has to paste into a service's
 *  Settings UI (e.g. Audiobookshelf). Vaultwarden picks up its secret via
 *  env so it doesn't need a paste — only a note about how to flip the
 *  feature on. */
function logOidcClientSecrets(opts: { selected: StackItem[]; variables: StackVariable[]; onLog: (msg: string) => void }): void {
  const isSelected = (name: string) => opts.selected.some(i => i.name === name);
  const domain = opts.variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;

  // Drive the per-service "paste this OIDC secret" hints from variable
  // metadata so client_id never duplicates between this file and
  // templates/.../variables.json. Variables that declare oidcClient + a
  // clientSecretVar that resolves to a wizard-generated secret get one
  // log line here.
  for (const sv of opts.variables) {
    const oidc = sv.meta?.oidcClient;
    if (!oidc?.clientSecretVar) continue;
    const secret = opts.variables.find(x => x.name === oidc.clientSecretVar)?.value;
    if (!secret || !domain) continue;
    const label = oidc.client_name || oidc.client_id;
    opts.onLog(`🔐 ${label} OIDC: issuer=https://auth.${domain}, client_id=${oidc.client_id}, client_secret=${secret} — paste into ${label} Settings → Authentication → OIDC.`);
  }

  // Vaultwarden's SSO doesn't fit the variable.oidcClient pattern (the secret
  // is consumed via env vars on the container, not a paste-into-UI flow), so
  // it stays as a special case until the schema grows a dedicated field.
  if (isSelected('vaultwarden')) {
    const secret = opts.variables.find(v => v.name === 'VAULTWARDEN_SSO_SECRET')?.value;
    const enabled = opts.variables.find(v => v.name === 'VAULTWARDEN_SSO_ENABLED')?.value;
    if (secret) {
      const status = enabled === 'true' ? 'SSO is ENABLED via env (test login then keep)' : 'SSO is OFF — flip VAULTWARDEN_SSO_ENABLED=true to enable';
      opts.onLog(`🔐 Vaultwarden OIDC: client_secret=${secret} (${status}).`);
    }
  }
}

function logNavidromeCredentials(opts: { variables: StackVariable[]; onLog: (msg: string) => void }): void {
  const user = opts.variables.find(v => v.name === 'NAVIDROME_ADMIN_USER')?.value || 'admin';
  const password = opts.variables.find(v => v.name === 'NAVIDROME_ADMIN_PASSWORD')?.value;
  const port = opts.variables.find(v => v.name === 'NAVIDROME_PORT')?.value || '4533';
  if (!password) return;
  opts.onLog(`🔑 Navidrome admin (user: ${user}, password: ${password}) — open http://<server-ip>:${port}. Subsonic clients (Symfonium etc.) use the same credentials.`);
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
 *  problem so the caller can hand control to the user. */
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

/** Poll until a media server's first-run init endpoint accepts our admin
 *  payload. Retries every 5s for up to 5 minutes — enough for image pull
 *  to finish on slow connections. */
async function seedMediaServer(opts: {
  service: 'audiobookshelf' | 'navidrome';
  variables: StackVariable[];
  userVar: string;
  passwordVar: string;
  portVar: string;
  defaultUser: string;
  defaultPort: string;
  serviceLabel: string;
  onLog: (msg: string) => void;
}): Promise<void> {
  const username = opts.variables.find(v => v.name === opts.userVar)?.value || opts.defaultUser;
  const password = opts.variables.find(v => v.name === opts.passwordVar)?.value;
  const port = opts.variables.find(v => v.name === opts.portVar)?.value || opts.defaultPort;
  if (!password) return;

  opts.onLog(`Waiting for ${opts.serviceLabel} to start...`);
  const start = Date.now();
  let lastBeat = 0;
  while (Date.now() - start < 5 * 60_000) {
    try {
      const res = await fetch('/api/system/media/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service: opts.service,
          host: 'localhost',
          port: parseInt(port, 10),
          username,
          password,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        opts.onLog(`✅ ${opts.serviceLabel} root user '${username}' created.`);
        return;
      }
      if (res.ok && data.alreadySetup) {
        opts.onLog(`ℹ️ ${opts.serviceLabel} already initialized — keeping existing admin. Reset manually if the password doesn't match.`);
        return;
      }
      // Other errors: keep retrying — service might still be cold-starting.
    } catch { /* not reachable yet */ }
    const elapsed = Date.now() - start;
    if (elapsed - lastBeat >= 10_000) {
      opts.onLog(`Still waiting for ${opts.serviceLabel} (${fmtElapsed(elapsed)} elapsed)...`);
      lastBeat = elapsed;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  opts.onLog(`⚠️ ${opts.serviceLabel} did not become reachable in 5 minutes. Open http://<server-ip>:${port} and create the admin user manually.`);
}

async function seedAudiobookshelf(opts: { variables: StackVariable[]; onLog: (msg: string) => void }): Promise<void> {
  return seedMediaServer({
    service: 'audiobookshelf',
    variables: opts.variables,
    userVar: 'ABS_ADMIN_USER',
    passwordVar: 'ABS_ADMIN_PASSWORD',
    portVar: 'ABS_PORT',
    defaultUser: 'root',
    defaultPort: '13378',
    serviceLabel: 'Audiobookshelf',
    onLog: opts.onLog,
  });
}

/** FileBrowser proxy-auth mode auto-creates user records on first SSO
 *  request, but the new account inherits non-admin defaults. Without an
 *  admin nobody can manage settings or other users — chicken-and-egg.
 *  Pre-promote one LLDAP user (default 'admin') to FileBrowser admin
 *  via the dedicated /api/system/filebrowser/init endpoint, which execs
 *  the FileBrowser CLI inside the running container. Idempotent. */
async function seedFileBrowserAdmin(opts: { variables: StackVariable[]; node?: string; onLog: (msg: string) => void }): Promise<void> {
  const username = opts.variables.find(v => v.name === 'FILEBROWSER_ADMIN_USER')?.value || 'admin';
  // Give the pod a moment to start before the first exec attempt — but the
  // real budget is in the retry loop below.
  await new Promise(r => setTimeout(r, 8000));
  // 36 attempts × 5 s = 3 min. The earlier 60-s budget timed out for users
  // on slow connections where the filebrowser image pull alone can take
  // 90 s+, leaving the wizard with the "Could not pre-seed FileBrowser
  // admin" warning and a manual `podman exec` fallback nobody actually runs.
  const MAX_ATTEMPTS = 36;
  let lastBeat = 0;
  const startedAt = Date.now();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('/api/system/filebrowser/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, node: opts.node }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        opts.onLog(`✅ FileBrowser admin: ${username} (${data.action}) — log in via Authelia at https://files.<your-domain> to manage shares.`);
        return;
      }
      // Container probably not ready yet — retry with backoff.
    } catch { /* retry */ }
    const elapsed = Date.now() - startedAt;
    if (elapsed - lastBeat >= 30_000) {
      opts.onLog(`Still waiting for FileBrowser to accept the admin seed (${fmtElapsed(elapsed)} elapsed)...`);
      lastBeat = elapsed;
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  opts.onLog('⚠️ Could not pre-seed FileBrowser admin after 3 minutes. Run `podman exec file-share-filebrowser filebrowser users add <user> _ --perm.admin --database /database/filebrowser.db` once the pod is up.');
}

async function seedNavidrome(opts: { variables: StackVariable[]; onLog: (msg: string) => void }): Promise<void> {
  return seedMediaServer({
    service: 'navidrome',
    variables: opts.variables,
    userVar: 'NAVIDROME_ADMIN_USER',
    passwordVar: 'NAVIDROME_ADMIN_PASSWORD',
    portVar: 'NAVIDROME_PORT',
    defaultUser: 'admin',
    defaultPort: '4533',
    serviceLabel: 'Navidrome',
    onLog: opts.onLog,
  });
}

interface SeedLldapOpts {
  variables: StackVariable[];
  onLog: (msg: string) => void;
}

/** Wait for LLDAP, then create the default admins+family groups. */
async function seedLldap(opts: SeedLldapOpts): Promise<void> {
  const password = opts.variables.find(v => v.name === 'LLDAP_ADMIN_PASSWORD')?.value;
  const port = opts.variables.find(v => v.name === 'LLDAP_PORT')?.value || '17170';
  if (!password) return;

  opts.onLog('Waiting for LLDAP to start (cold-start usually < 30s)...');
  const ready = await waitForLldap('localhost', parseInt(port, 10), opts.onLog);
  if (!ready) {
    opts.onLog(`⚠️ LLDAP did not respond in time. Open http://<server-ip>:${port} as admin and create groups admins+family manually.`);
    return;
  }

  opts.onLog('Seeding LLDAP groups...');
  try {
    const res = await fetch('/api/system/lldap/seed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: 'localhost',
        port: parseInt(port, 10),
        password,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      if (data.created?.length) opts.onLog(`✅ Groups created: ${data.created.join(', ')}`);
      if (data.existing?.length) opts.onLog(`ℹ️ Groups already exist: ${data.existing.join(', ')}`);
      if (data.failed?.length) opts.onLog(`⚠️ Failed: ${data.failed.map((f: { name: string }) => f.name).join(', ')}`);
    } else {
      opts.onLog(`⚠️ Could not seed LLDAP groups: ${data.error || 'unknown error'}`);
    }
  } catch {
    opts.onLog('⚠️ Could not reach LLDAP to seed groups. Create admins/family manually in the LLDAP UI.');
  }
}

interface RunPostInstallOpts {
  selected: StackItem[];
  variables: StackVariable[];
  node?: string;
  onLog: (msg: string) => void;
  /**
   * Templates whose post-deploy.py already handled credential logging +
   * admin seeding. Hardcoded helpers below check this set and skip per-
   * template work that the script already did, so we don't double-emit
   * credentials or re-call admin-init endpoints.
   *
   * Phase 1 — only `media` migrates. Other templates' hardcoded paths
   * still run as before. As more templates ship post-deploy.py the
   * branches in this function will shrink.
   */
  skipDefaults?: Set<string>;
  /**
   * Credentials parsed from `__SB_CREDENTIAL__` markers a template's
   * post-deploy.py emitted on stdout. Appended to the SAVE-THESE-NOW
   * banner alongside the hardcoded entries.
   */
  // Re-using the Credential shape from credentialsManifest without an
  // import cycle — the entries already conform.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraCredentials?: any[];
}

/** Orchestrate every post-install step. Returns the proxy-route status so
 *  the caller can decide whether to render the NPM-credential prompt.
 *
 *  LLDAP group seeding is **fire-and-forget**: it runs in the background
 *  while we await the proxy step. That way the NPM credentials prompt
 *  appears as soon as the proxy call returns, instead of waiting on the
 *  LLDAP cold-start (up to 10 minutes). Seed logs interleave with proxy
 *  logs in the install panel — both streams are independent. */
export async function runPostInstall(opts: RunPostInstallOpts): Promise<ProxyResult> {
  const { selected, variables, node, onLog, skipDefaults, extraCredentials } = opts;
  const isSelected = (name: string) => selected.some(i => i.name === name);
  const handled = (name: string): boolean => skipDefaults?.has(name) ?? false;

  // Surface credentials immediately — independent of any wait.
  // LLDAP + Authelia live in the merged 'auth' stack now; whenever the auth
  // stack is selected, both run together.
  if (isSelected('auth') && !handled('auth')) {
    await persistLldapCredentials({ variables, onLog });
  }
  if (isSelected('adguard') && !handled('adguard')) {
    logAdguardCredentials({ variables, onLog });
  }
  // Audiobookshelf + Navidrome live in the merged 'media' stack now.
  if (isSelected('media') && !handled('media')) {
    logAudiobookshelfCredentials({ variables, onLog });
    logNavidromeCredentials({ variables, onLog });
  }
  if (isSelected('file-share') && !handled('file-share')) {
    logFileShareCredentials({ variables, onLog });
  }
  // Surface OIDC client secrets (one log line per service that needs UI
  // configuration or has an env-flag to flip). Driven by variables[].meta
  // so it stays template-driven regardless of skipDefaults.
  logOidcClientSecrets({ selected, variables, onLog });
  // NPM bootstrap is best-effort: if it fails we still want to run the rest
  // of the post-install pipeline (LLDAP seeding, OIDC client creation, proxy
  // routes) — the user can finish the NPM piece via the credentials prompt.
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

  // Kick off all "wait + initialize" tasks in the background. Their logs
  // interleave with the proxy step's, but the proxy result returns ASAP
  // so the NPM credentials prompt (if needed) appears responsive.
  if (isSelected('auth') && !handled('auth')) {
    void seedLldap({ variables, onLog }).catch(() => { /* logged inline */ });
  }
  if (isSelected('media') && !handled('media')) {
    void seedAudiobookshelf({ variables, onLog }).catch(() => { /* logged inline */ });
    void seedNavidrome({ variables, onLog }).catch(() => { /* logged inline */ });
  }
  // FileBrowser is now part of the file-share stack (alongside syncthing + samba).
  if (isSelected('file-share') && !handled('file-share')) {
    void seedFileBrowserAdmin({ variables, node, onLog }).catch(() => { /* logged inline */ });
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

  // Final banner — single block where every credential the user might
  // have to remember is collected. Same data is exposed to the wizard's
  // Done view + a Bitwarden CSV download via buildCredentialsManifest().
  // Per-template post-deploy.py output is appended to whatever the
  // hardcoded helpers produced for templates that haven't migrated yet.
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const manifest = [
    ...buildCredentialsManifest({ selected, variables, host }),
    ...(extraCredentials ?? []),
  ];
  formatCredentialsBanner(manifest).forEach(onLog);

  return proxyResult;
}
