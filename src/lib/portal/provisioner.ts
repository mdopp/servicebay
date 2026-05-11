/**
 * Portal apex/www provisioner (#242 follow-up).
 *
 * Idempotently ensures family-portal access at the apex and www
 * subdomain of the active install domain:
 *
 *   1. NPM proxy host with `domain_names: ['<domain>', 'www.<domain>']`
 *      forwarding to ServiceBay's host port. Created via the same
 *      `/api/system/nginx/proxy-hosts` path the wizard uses; safe to
 *      re-run.
 *   2. AdGuard rewrites for `<domain>` and `www.<domain>` → ServiceBay
 *      LAN IP. The existing wildcard `*.<domain>` covers most
 *      subdomains but typically not the apex; explicit rewrites
 *      close the gap.
 *
 * Called from server-startup (with a delay so cold-starting nginx
 * and adguard have time to come up) and via the manual provision
 * endpoint. Errors are non-fatal — logged and retried on the next
 * boot. The function only acts when both nginx and adguard are
 * actually up and reachable.
 *
 * The middleware (`proxy.ts`) handles the application-side
 * rewrite from `<domain>/whatever` → /portal so this module only
 * deals with the proxy/DNS plumbing.
 */

import { getConfig } from '@/lib/config';
import { getActiveDomain } from '@/lib/mode';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { ensureWildcardRewrite } from '@/lib/adguard/rewrites';
import { logger } from '@/lib/logger';

const LOG = 'portal:provisioner';

type RewriteResult = 'added' | 'updated' | 'unchanged' | 'failed';

interface ProvisionResult {
  ok: boolean;
  detail: string;
  proxyHost?: 'created' | 'unchanged' | 'failed' | 'skipped';
  /** Per-rewrite outcomes, keyed by AdGuard domain pattern. */
  rewrites?: Record<string, RewriteResult>;
}

/** Locate ServiceBay's own LAN IP from config. Used as the rewrite
 *  target in AdGuard so devices resolving the apex see ServiceBay. */
async function findServiceBayLanIp(): Promise<string | null> {
  const config = await getConfig();
  return config.reverseProxy?.lanIp ?? null;
}

/** Find AdGuard admin URL + password from config. Prefer the dedicated
 *  `config.adguard` block (written by AdGuard's post-deploy via
 *  /api/system/adguard/credentials) and fall back to the legacy
 *  templateSettings lookup for installs that predate the credentials
 *  endpoint. */
async function findAdguardCreds(): Promise<{ adminUrl: string; username: string; password: string } | null> {
  const config = await getConfig();
  if (config.adguard?.password) {
    return {
      adminUrl: config.adguard.adminUrl || `http://localhost:${config.templateSettings?.ADGUARD_ADMIN_PORT ?? '8083'}`,
      username: config.adguard.username || 'admin',
      password: config.adguard.password,
    };
  }
  const password = config.templateSettings?.ADGUARD_ADMIN_PASSWORD;
  const port = config.templateSettings?.ADGUARD_ADMIN_PORT ?? '8083';
  if (!password) return null;
  return {
    adminUrl: `http://localhost:${port}`,
    username: 'admin',
    password,
  };
}

/** Build the NPM proxy-host POST body for the apex+www → ServiceBay
 *  route. Forwards to ServiceBay's container port (PORT env, default
 *  5888). NPM is in a podman pod so the forward host is the LAN IP,
 *  not 127.0.0.1. */
function buildPortalProxyHost(domain: string, lanIp: string): {
  hosts: Array<{
    domain: string;
    forwardPort: number;
    forwardHost: string;
    forwardScheme: string;
    service: string;
  }>;
} {
  const port = parseInt(process.env.PORT ?? '5888', 10);
  // Encode both names into a single NPM host. The /api/system/nginx/
  // proxy-hosts route currently creates one NPM host per domain
  // entry, so we pass two list entries with the same target. NPM's
  // de-dupe behaviour will collapse them on update.
  return {
    hosts: [
      { domain, forwardPort: port, forwardHost: lanIp, forwardScheme: 'http', service: 'servicebay-portal' },
      { domain: `www.${domain}`, forwardPort: port, forwardHost: lanIp, forwardScheme: 'http', service: 'servicebay-portal' },
    ],
  };
}

async function provisionNpmProxyHost(domain: string): Promise<ProvisionResult['proxyHost']> {
  // Ask the running nginx service for its admin URL via ServiceManager
  // — this is how the existing diagnose probes find NPM. If nginx
  // isn't deployed yet, skip silently.
  try {
    const services = await ServiceManager.listServices('Local');
    const nginx = services.find(s =>
      s.name === 'nginx' || s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
    );
    if (!nginx?.active) {
      return 'skipped';
    }
  } catch {
    return 'skipped';
  }

  const lanIp = await findServiceBayLanIp();
  if (!lanIp) {
    logger.warn(LOG, 'No LAN IP recorded in config — install-time detection hasn\'t run; skipping NPM provision');
    return 'skipped';
  }

  // Round-trip through the proxy-hosts route so we reuse its
  // credential resolution, retry, and persistence behaviour. Internal
  // token bypasses the auth gate.
  const { getInternalApiToken } = await import('@/lib/auth/internalToken');
  const token = getInternalApiToken();
  const port = process.env.PORT ?? '5888';
  const url = `http://localhost:${port}/api/system/nginx/proxy-hosts`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SB-Internal-Token': token },
      body: JSON.stringify(buildPortalProxyHost(domain, lanIp)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      logger.warn(LOG, `NPM proxy-host POST returned HTTP ${res.status}: ${data.error ?? 'unknown'}`);
      return 'failed';
    }
    const data = await res.json().catch(() => ({})) as { created?: string[]; failed?: { domain: string; error: string }[] };
    if (data.failed && data.failed.length > 0) {
      // The route returns ok with partial-failures embedded — report
      // 'unchanged' if NPM rejected the host because it already
      // exists (the most common case on a re-run).
      const allDuplicates = data.failed.every(f => /already exists/i.test(f.error));
      if (allDuplicates) return 'unchanged';
      logger.warn(LOG, `NPM rejected: ${data.failed.map(f => `${f.domain}: ${f.error}`).join('; ')}`);
      return 'failed';
    }
    return data.created && data.created.length > 0 ? 'created' : 'unchanged';
  } catch (e) {
    logger.warn(LOG, `Failed to reach NPM proxy-host endpoint: ${e instanceof Error ? e.message : String(e)}`);
    return 'failed';
  }
}

async function provisionAdguardRewrite(name: string, lanIp: string): Promise<'added' | 'updated' | 'unchanged' | 'failed'> {
  const creds = await findAdguardCreds();
  if (!creds) return 'failed';
  return ensureWildcardRewrite({
    adminUrl: creds.adminUrl,
    username: creds.username,
    password: creds.password,
  }, name, lanIp);
}

/**
 * The full provisioning flow. Idempotent — safe to call from server
 * startup AND from a manual endpoint. Returns a structured result so
 * callers can log + decide whether to retry.
 */
export async function provisionPortalRouting(): Promise<ProvisionResult> {
  const config = await getConfig();
  const activeDomain = getActiveDomain(config);
  if (!activeDomain) {
    return { ok: false, detail: 'No active domain configured.' };
  }
  const lanIp = await findServiceBayLanIp();
  if (!lanIp) {
    return { ok: false, detail: 'No LAN IP recorded in config — install-time detection hasn\'t run yet.' };
  }

  // NPM apex+www proxy host. Only the active domain needs an NPM
  // host — that's where browser traffic actually hits ServiceBay.
  const proxyHost = await provisionNpmProxyHost(activeDomain);

  // AdGuard rewrites. Two-domain split-horizon for typical home installs:
  //   * `lanDomain` (default `home.arpa`) — always present. Devices
  //     resolving `<lan>` or `*.<lan>` need to hit ServiceBay directly.
  //   * `publicDomain` (e.g. `dopp.cloud`) — when set, LAN devices
  //     resolving `<public>` or `*.<public>` should bypass the
  //     FritzBox-hairpin-NAT and reach ServiceBay over the LAN.
  // For each domain we install three rewrites:
  //   - <domain> → lanIp                       (portal apex)
  //   - www.<domain> → lanIp                   (portal apex, with www)
  //   - *.<domain> → lanIp                     (subdomain catch-all)
  // AdGuard accepts both literal and wildcard patterns at the same
  // endpoint; the wildcard pattern is the standard catch-all for any
  // service subdomain (vault, immich, dns, …) that NPM routes by
  // Host-header behind ServiceBay.
  const rewriteDomains = new Set<string>();
  const lanDomain = config.reverseProxy?.lanDomain ?? 'home.arpa';
  const publicDomain = config.reverseProxy?.publicDomain;
  if (lanDomain) rewriteDomains.add(lanDomain);
  if (publicDomain) rewriteDomains.add(publicDomain);

  const rewrites: Record<string, RewriteResult> = {};
  for (const d of rewriteDomains) {
    rewrites[d] = await provisionAdguardRewrite(d, lanIp);
    rewrites[`www.${d}`] = await provisionAdguardRewrite(`www.${d}`, lanIp);
    rewrites[`*.${d}`] = await provisionAdguardRewrite(`*.${d}`, lanIp);
  }

  const anyRewriteFailed = Object.values(rewrites).some(r => r === 'failed');
  const ok = proxyHost !== 'failed' && !anyRewriteFailed;
  const summary = `proxy:${proxyHost} rewrites=${Object.entries(rewrites).map(([k, v]) => `${k}:${v}`).join(',')}`;
  if (ok) {
    logger.info(LOG, `Portal routing provisioned for ${activeDomain} (${summary})`);
  } else {
    logger.warn(LOG, `Portal routing provisioning had failures for ${activeDomain} (${summary})`);
  }
  return { ok, detail: summary, proxyHost, rewrites };
}
