/**
 * `nginx_online_failed` probe (#2156) — surfaces NPM proxy hosts that NPM
 * accepted (HTTP 200 on create) but nginx then REFUSED to load: NPM sets
 * the host's `meta.nginx_online` to false and stashes the `[emerg]` reason
 * in `meta.nginx_err`. This is the exact buerolicht/tor.dopp.cloud failure
 * mode — a bad advanced_config (duplicate acme-challenge location) reverted
 * the conf, so the domain 000s/502s while every other signal stays green.
 *
 * The ground truth already exists in NPM (it records nginx_err in
 * proxy_host.meta in its database.sqlite, and mirrors it into the
 * GET /api/nginx/proxy-hosts response), but nothing surfaced it — this
 * probe reads NPM's host list and lights up every host whose nginx_online
 * is false, with the nginx_err text and a per-row "Re-render route" action
 * that disable→enables the host to force NPM to regenerate + reload the
 * conf once the operator has fixed the underlying advanced_config.
 *
 * Sibling of `dangling_proxy` (stale routes) and `proxy_route_missing`
 * (creation failed): this one is "created, but nginx won't serve it".
 */

import { getConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

const PROBE_ID = 'nginx_online_failed';

export interface NginxOnlineFailedResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

interface NpmHost {
  id?: number;
  domain_names?: string[];
  meta?: { nginx_online?: boolean; nginx_err?: string | null };
}

/** Locate NPM's admin URL on the given node. Returns null when nginx
 *  isn't deployed or its admin port can't be derived. Mirrors the
 *  helper in danglingProxy.ts / npmDataStale.ts — kept local to avoid
 *  coupling probes to each other. */
async function findNpmAdminUrl(node: string): Promise<string | null> {
  try {
    const services = await ServiceManager.listServices(node);
    const nginx = services.find(
      s => s.name === 'nginx' || s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
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

/** Try stored credentials first, then NPM defaults. Returns the bearer
 *  token, or null when nothing works. Mirrors danglingProxy.ts. */
async function getNpmToken(adminUrl: string): Promise<string | null> {
  const config = await getConfig();
  const candidates: { identity: string; secret: string }[] = [];
  const stored = config.reverseProxy?.npm;
  if (stored?.email && stored?.password) {
    candidates.push({ identity: stored.email, secret: stored.password });
  }
  candidates.push({ identity: 'admin@example.com', secret: 'changeme' });

  for (const cred of candidates) {
    try {
      const res = await fetch(`${adminUrl}/api/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cred),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.token === 'string') return data.token;
      }
    } catch {
      // try next
    }
  }
  return null;
}

/** Fetch NPM's proxy host list. Returns null on any failure so the probe
 *  degrades to `info` instead of a false `ok`. */
async function fetchNpmHosts(adminUrl: string, token: string): Promise<NpmHost[] | null> {
  try {
    const res = await fetch(`${adminUrl}/api/nginx/proxy-hosts`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const hosts = await res.json();
    return Array.isArray(hosts) ? (hosts as NpmHost[]) : null;
  } catch {
    return null;
  }
}

export async function checkNginxOnlineFailed(node: string): Promise<NginxOnlineFailedResult> {
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) {
    return { status: 'info', detail: 'Nginx Proxy Manager is not deployed or not active on this node.' };
  }
  const token = await getNpmToken(adminUrl);
  if (!token) {
    return {
      status: 'info',
      detail: 'Could not authenticate against NPM to read per-host nginx status. If npm_data_stale is also warning, fix that first.',
    };
  }
  const hosts = await fetchNpmHosts(adminUrl, token);
  if (hosts === null) {
    return { status: 'info', detail: 'Could not read the NPM proxy host list.' };
  }
  const offline = hosts.filter(h => h.meta?.nginx_online === false);
  if (offline.length === 0) {
    return {
      status: 'ok',
      detail: `${hosts.length} proxy host${hosts.length === 1 ? '' : 's'} recorded; nginx loaded every conf (nginx_online=true).`,
    };
  }
  const items: ProbeItem[] = offline.map(h => {
    const domain = h.domain_names?.[0] ?? `host ${h.id ?? '?'}`;
    const err = (h.meta?.nginx_err ?? '').trim() || 'nginx reverted the conf (no error text recorded).';
    return {
      id: domain,
      label: domain,
      // The [emerg] reason is the actionable content — put it on the row.
      detail: err.slice(0, 400),
      status: 'fail',
      actionIds: ['rerender_host'],
    };
  });
  return {
    status: 'fail',
    detail: `${offline.length} proxy host${offline.length === 1 ? '' : 's'} exist in NPM but nginx refused the conf (nginx_online=false) — those domains return 000/502 while everything else looks green.`,
    hint: 'Fix the host\'s advanced_config (the row shows the [emerg] reason), then click "Re-render route" to make NPM regenerate + reload the conf.',
    items,
  };
}

/**
 * Map a domain (server_name) to NPM's numeric proxy_host id. Returns null
 * when no host matches or the request fails.
 */
async function resolveProxyHostId(adminUrl: string, token: string, domain: string): Promise<number | null> {
  const hosts = await fetchNpmHosts(adminUrl, token);
  if (!hosts) return null;
  for (const h of hosts) {
    if ((h.domain_names ?? []).includes(domain) && typeof h.id === 'number') return h.id;
  }
  return null;
}

/**
 * Force NPM to regenerate + reload a host's conf by disabling then
 * re-enabling it. NPM rewrites the .conf and runs nginx -t/reload on both
 * transitions, so once the operator fixed the offending advanced_config
 * this clears nginx_online back to true (or re-surfaces a still-broken
 * conf with the fresh error).
 */
async function rerenderHost({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No domain supplied — cannot re-render.', refresh: false };
  }
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) {
    return { ok: false, message: 'Nginx Proxy Manager is not deployed or active on this node.', refresh: false };
  }
  const token = await getNpmToken(adminUrl);
  if (!token) {
    return {
      ok: false,
      message: 'Could not authenticate against NPM. If npm_data_stale is also showing, fix that first.',
      refresh: false,
    };
  }
  const id = await resolveProxyHostId(adminUrl, token, itemId);
  if (id === null) {
    return {
      ok: false,
      message: `Couldn't find an NPM proxy host for ${itemId} — it may have been deleted since the probe ran.`,
      refresh: true,
    };
  }
  return performRerender(adminUrl, token, id, itemId);
}

/** Issue disable→enable against NPM and read back nginx_online. Split out
 *  of rerenderHost to stay under the function-length budget. */
async function performRerender(
  adminUrl: string,
  token: string,
  id: number,
  itemId: string,
): Promise<ProbeActionResult> {
  const call = (path: string) =>
    fetch(`${adminUrl}/api/nginx/proxy-hosts/${id}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  try {
    await call('disable');
    const enableRes = await call('enable');
    if (!enableRes.ok) {
      const body = await enableRes.text().catch(() => '');
      logger.warn('diagnose:nginx_online_failed', `re-enable id=${id} (${itemId}) returned HTTP ${enableRes.status}: ${body.slice(0, 200)}`);
      return { ok: false, message: `NPM returned HTTP ${enableRes.status} re-enabling ${itemId}.`, refresh: true };
    }
    // Read back the live status so the toast tells the operator whether the
    // conf actually loaded this time — a re-render on a still-broken config
    // just re-populates nginx_err.
    const hosts = await fetchNpmHosts(adminUrl, token);
    const host = hosts?.find(h => h.id === id);
    if (host?.meta?.nginx_online === false) {
      const err = (host.meta.nginx_err ?? '').trim();
      return {
        ok: false,
        message: `${itemId} still offline after re-render — nginx rejected the conf again. Fix the advanced_config, then retry.`,
        details: err || undefined,
        refresh: true,
      };
    }
    return { ok: true, message: `${itemId} re-rendered — nginx loaded the conf (nginx_online=true).`, refresh: true };
  } catch (e) {
    return {
      ok: false,
      message: `Failed to reach NPM while re-rendering ${itemId}: ${e instanceof Error ? e.message : String(e)}`,
      refresh: false,
    };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'rerender_host',
    label: 'Re-render route',
    description:
      'Disables then re-enables this proxy host so Nginx Proxy Manager regenerates its config and runs nginx -t / reload. Use after fixing the advanced_config the [emerg] error points at — if the config is still bad, nginx just rejects it again and the error re-appears.',
  },
  rerenderHost,
);
