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

async function retryCreate({
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

  // Re-derive forward host from the running nginx service so the
  // entry can be retried with whatever the install-time defaults are.
  // Mirrors what /api/system/nginx/proxy-hosts does for entries that
  // omit forwardHost.
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

  // The /api/system/nginx/proxy-hosts route accepts cross-process
  // calls with internal-token auth. We import the helper so the
  // diagnose-handler can act as a server-internal caller without
  // needing a session token.
  const { getInternalApiToken } = await import('@/lib/auth/internalToken');
  const token = getInternalApiToken();
  const port = process.env.PORT || '5888';
  const url = `http://localhost:${port}/api/system/nginx/proxy-hosts`;

  let res: Response;
  try {
    res = await fetch(url, {
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
    return {
      ok: false,
      message: `Could not reach the proxy-hosts API: ${e instanceof Error ? e.message : String(e)}.`,
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
  return {
    ok: false,
    message: failure?.error
      ? `NPM rejected the route: ${failure.error.slice(0, 200)}`
      : `Retry returned HTTP ${res.status} without a domain-specific error.`,
    refresh: false,
  };
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
