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
  if (isSelected('nginx-web')) {
    await persistNpmCredentials({ variables, onLog });
  }

  // Kick off LLDAP seed in the background; failures are logged via onLog
  // inside seedLldap itself, so an unhandled rejection here is fine to
  // swallow.
  if (isSelected('lldap')) {
    void seedLldap({ variables, onLog }).catch(() => { /* logged inline */ });
  }

  return configureProxyRoutes({ variables, node, onLog });
}
