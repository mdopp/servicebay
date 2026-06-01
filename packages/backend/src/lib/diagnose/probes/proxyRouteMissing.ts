/**
 * `proxy_route_missing` probe (B12 / #241) — surfaces NPM proxy host
 * entries persisted in `config.reverseProxy.hosts` whose creation
 * failed (`created === false`). Without this probe the failures are
 * silent: install completes, the host entry is recorded with
 * `created: false`, and the next time someone hits `<sub>.<domain>`
 * NPM returns a default 404 instead of routing to the service.
 *
 * Each unconfirmed host becomes one item with a per-row "Retry create"
 * action that POSTs back to `/api/system/nginx/proxy-hosts` — the
 * same path the wizard uses, so any fix that worked there (NPM auth
 * fixed via the `npm_data_stale.use_existing` action, network restored)
 * cleans this up too.
 *
 * Inverse direction of `dangling_proxy` (#251): that one removes
 * stale routes; this one creates missing ones.
 */

import { getConfig, type ProxyHostEntry } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

const PROBE_ID = 'proxy_route_missing';

export interface ProxyRouteMissingResult {
  status: 'ok' | 'warn' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

export async function checkProxyRouteMissing(): Promise<ProxyRouteMissingResult> {
  const config = await getConfig();
  const hosts = config.reverseProxy?.hosts ?? [];
  if (hosts.length === 0) {
    return {
      status: 'info',
      detail: 'No proxy host entries recorded yet.',
    };
  }
  const missing = hosts.filter(h => !h.created);
  if (missing.length === 0) {
    return {
      status: 'ok',
      detail: `${hosts.length} proxy host${hosts.length === 1 ? '' : 's'} recorded, all marked as created.`,
    };
  }
  const items: ProbeItem[] = missing.map(h => ({
    id: h.domain,
    label: h.domain,
    detail: `→ port ${h.forwardPort} (service: ${h.service})`,
    status: 'warn',
    actionIds: ['retry_create'],
  }));
  return {
    status: 'warn',
    detail: `${missing.length} of ${hosts.length} proxy host${hosts.length === 1 ? '' : 's'} failed to create on install. Traffic to those domains hits NPM's default 404.`,
    hint: 'Click "Retry create" on a row to push the route into NPM. If retries keep failing, look at the npm_data_stale probe — wrong creds is the most common cause.',
    items,
  };
}

/**
 * Locate the matching ProxyHostEntry for a domain. Returns null when
 * the entry vanished between probe-collection and action-dispatch
 * (rare but possible if another tab edited config in between).
 */
async function findEntry(domain: string): Promise<ProxyHostEntry | null> {
  const config = await getConfig();
  const hosts = config.reverseProxy?.hosts ?? [];
  return hosts.find(h => h.domain === domain) ?? null;
}

/**
 * Shared with `domain_unreachable` — when that probe diagnoses
 * "proxy host not confirmed in NPM", it surfaces this same retry as
 * an inline per-row action so the operator doesn't have to navigate.
 * Exported (not just registered) so the sibling probe can mount it
 * under its own action namespace.
 */
async function checkNginxDeployed(node: string): Promise<ProbeActionResult | null> {
  const services = await ServiceManager.listServices(node).catch(() => []);
  const nginx = services.find(
    s => s.name === 'nginx' || s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
  );
  if (!nginx?.active) {
    return {
      ok: false,
      message: 'Nginx Proxy Manager is not deployed or not active on this node — cannot create routes until it is.',
      refresh: false,
    };
  }
  return null;
}

async function callProxyHostsApi(node: string, entry: ProxyHostEntry): Promise<Response> {
  const { getInternalApiToken } = await import('@/lib/auth/internalToken');
  const token = getInternalApiToken();
  const port = process.env.PORT || '5888';
  const url = `http://localhost:${port}/api/system/nginx/proxy-hosts`;

  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SB-Internal-Token': token,
      },
      body: JSON.stringify({
        node,
        hosts: [{
          domain: entry.domain,
          service: entry.service,
          forwardPort: entry.forwardPort,
        }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not reach the proxy-hosts API: ${msg}. ${pointerForFetchError(msg)}`);
  }
}

export async function retryCreate({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No domain supplied.', refresh: false };
  }
  const entry = await findEntry(itemId);
  if (!entry) {
    return { ok: false, message: `No proxy host entry for ${itemId} — it may have been removed.`, refresh: true };
  }

  const nginxCheck = await checkNginxDeployed(node);
  if (nginxCheck) return nginxCheck;

  let res: Response;
  try {
    res = await callProxyHostsApi(node, entry);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      message: msg,
      refresh: false,
    };
  }

  const data = await res.json().catch(() => ({})) as {
    success?: boolean;
    created?: string[];
    failed?: { domain: string; error: string }[];
    needsCredentials?: boolean;
  };

  if (data.needsCredentials) {
    return {
      ok: false,
      message: 'NPM rejected the stored credentials. Run the npm_data_stale probe\'s "Use existing password" action first, then retry.',
      refresh: false,
    };
  }

  if (data.success) {
    return {
      ok: true,
      message: `Route ${entry.domain} created in NPM.`,
      refresh: true,
    };
  }
  const failure = (data.failed ?? []).find(f => f.domain === entry.domain);
  logger.warn('diagnose:proxy_route_missing', `Retry create for ${entry.domain} failed: ${failure?.error ?? 'unknown'}`);
  const failureMsg = failure?.error
    ? `NPM rejected the route: ${failure.error.slice(0, 200)} ${pointerForNpmError(failure.error)}`.trimEnd()
    : `Retry returned HTTP ${res.status} without a domain-specific error. See failed_units / pods_and_engine for NPM container health.`;
  return {
    ok: false,
    message: failureMsg,
    refresh: false,
  };
}

/** Sibling-probe pointer based on the fetch-level error text. Lets
 *  the operator skip a hop instead of guessing which probe to open
 *  when retry fails — connection-refused points at the engine, DNS
 *  errors at network. */
function pointerForFetchError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('econnrefused') || m.includes('connection refused')) {
    return 'NPM container is likely not running — check pods_and_engine + failed_units.';
  }
  if (m.includes('etimedout') || m.includes('timeout')) {
    return 'NPM is unreachable in time — likely a heavy container restart or a sibling pod blocking the port. Check pods_and_engine.';
  }
  if (m.includes('enotfound') || m.includes('getaddrinfo')) {
    return 'localhost name lookup failed — the install host is in an unusual DNS state.';
  }
  return '';
}

/** Sibling-probe pointer based on NPM's domain-level error text. Same
 *  intent — short-cut the diagnosis tree by naming the right probe. */
function pointerForNpmError(err: string): string {
  const m = err.toLowerCase();
  if (m.includes('401') || m.includes('unauthor') || m.includes('forbidden')) {
    return '→ npm_data_stale: NPM credentials likely rejected.';
  }
  if (m.includes('certificate') || m.includes('cert')) {
    return '→ cert_request_failure: the ACME side likely failed; see the categorised log tail.';
  }
  if (m.includes('forward_host') || m.includes('forward_port') || m.includes('upstream')) {
    return '→ check that the target service is actually running (Services list).';
  }
  return '';
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'retry_create',
    label: 'Retry create',
    description:
      'Pushes this proxy host into Nginx Proxy Manager again. Uses the same path the install wizard uses — fixes the same way (correct NPM creds, NPM reachable).',
  },
  retryCreate,
);
