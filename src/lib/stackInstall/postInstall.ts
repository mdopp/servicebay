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

/** Build the proxy-host list from subdomain-typed variables. */
function buildProxyHosts(variables: StackVariable[]): {
  domain: string | undefined;
  hosts: { domain: string; forwardPort: number; service: string; proxyConfig?: unknown }[];
} {
  const domain = variables.find(v => v.name === 'PUBLIC_DOMAIN')?.value;
  if (!domain) return { domain, hosts: [] };
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
      proxyConfig: sv.meta?.proxyConfig,
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

  if (isSelected('audiobookshelf')) {
    const secret = opts.variables.find(v => v.name === 'ABS_OIDC_SECRET')?.value;
    if (secret && domain) {
      opts.onLog(`🔐 Audiobookshelf OIDC: issuer=https://auth.${domain}, client_id=audiobookshelf, client_secret=${secret} — paste into ABS Settings → Authentication → OIDC.`);
    }
  }

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

/** Persist NPM admin credentials so subsequent proxy-host operations
 *  authenticate without prompting. */
async function persistNpmCredentials(opts: { variables: StackVariable[]; onLog: (msg: string) => void }): Promise<void> {
  const email = opts.variables.find(v => v.name === 'NGINX_ADMIN_EMAIL')?.value;
  const password = opts.variables.find(v => v.name === 'NGINX_ADMIN_PASSWORD')?.value;
  if (!email || !password) return;
  try {
    await fetch('/api/system/nginx/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    opts.onLog('✅ Saved NPM admin credentials for auto-sync.');
  } catch {
    opts.onLog('⚠️ Could not persist NPM credentials — set them later in Settings → Integrations.');
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
  // Give the pod ~30s to come up before we exec into it.
  await new Promise(r => setTimeout(r, 8000));
  for (let attempt = 0; attempt < 12; attempt++) {
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
    await new Promise(r => setTimeout(r, 5000));
  }
  opts.onLog('⚠️ Could not pre-seed FileBrowser admin. Run `podman exec filebrowser-filebrowser filebrowser users add <user> _ --perm.admin --database /database/filebrowser.db` once the pod is up.');
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
  const { selected, variables, node, onLog } = opts;
  const isSelected = (name: string) => selected.some(i => i.name === name);

  // Surface credentials immediately — independent of any wait.
  if (isSelected('lldap')) {
    await persistLldapCredentials({ variables, onLog });
  }
  if (isSelected('adguard')) {
    logAdguardCredentials({ variables, onLog });
  }
  if (isSelected('audiobookshelf')) {
    logAudiobookshelfCredentials({ variables, onLog });
  }
  if (isSelected('navidrome')) {
    logNavidromeCredentials({ variables, onLog });
  }
  if (isSelected('file-share')) {
    logFileShareCredentials({ variables, onLog });
  }
  // Surface OIDC client secrets (one log line per service that needs UI
  // configuration or has an env-flag to flip).
  logOidcClientSecrets({ selected, variables, onLog });
  if (isSelected('nginx-web')) {
    await persistNpmCredentials({ variables, onLog });
  }

  // Kick off all "wait + initialize" tasks in the background. Their logs
  // interleave with the proxy step's, but the proxy result returns ASAP
  // so the NPM credentials prompt (if needed) appears responsive.
  if (isSelected('lldap')) {
    void seedLldap({ variables, onLog }).catch(() => { /* logged inline */ });
  }
  if (isSelected('audiobookshelf')) {
    void seedAudiobookshelf({ variables, onLog }).catch(() => { /* logged inline */ });
  }
  if (isSelected('navidrome')) {
    void seedNavidrome({ variables, onLog }).catch(() => { /* logged inline */ });
  }
  if (isSelected('filebrowser')) {
    void seedFileBrowserAdmin({ variables, node, onLog }).catch(() => { /* logged inline */ });
  }

  const proxyResult = await configureProxyRoutes({ variables, node, onLog });

  // Final banner — single block where every credential the user might
  // have to remember is collected. Same data is exposed to the wizard's
  // Done view + a Bitwarden CSV download via buildCredentialsManifest().
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  const manifest = buildCredentialsManifest({ selected, variables, host });
  formatCredentialsBanner(manifest).forEach(onLog);

  return proxyResult;
}
