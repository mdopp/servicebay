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
 * proxy-host list its admin API returns), but nothing surfaced it — this
 * probe reads NPM's host list and lights up every host whose nginx_online
 * is false, with the nginx_err text and a per-row "Re-render route" action
 * that disable→enables the host to force NPM to regenerate + reload the
 * conf once the operator has fixed the underlying advanced_config.
 *
 * Sibling of `dangling_proxy` (stale routes) and `proxy_route_missing`
 * (creation failed): this one is "created, but nginx won't serve it".
 */

import { logger } from '@/lib/logger';
import { findNpmAdmin, getNpmToken } from '@/lib/npm/client';
import { listProxyHosts, setProxyHostEnabled, type NpmProxyHost } from '@/lib/npm/proxyHosts';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

const PROBE_ID = 'nginx_online_failed';

export interface NginxOnlineFailedResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

type NpmHost = NpmProxyHost;

/** Fetch NPM's proxy host list. Returns null on any failure so the probe
 *  degrades to `info` instead of a false `ok`. */
async function fetchNpmHosts(adminUrl: string, token: string): Promise<NpmHost[] | null> {
  try {
    const res = await listProxyHosts(adminUrl, token, { timeoutMs: 8000 });
    if (!res.ok) return null;
    return Array.isArray(res.data) ? res.data : null;
  } catch {
    return null;
  }
}

export async function checkNginxOnlineFailed(node: string): Promise<NginxOnlineFailedResult> {
  // requireActive: false — the twin's `active` flag lies for the kube nginx
  // pod (#496); the per-host status read below is the real liveness check.
  const adminUrl = (await findNpmAdmin({ node, requireActive: false }))?.apiUrl;
  if (!adminUrl) {
    return { status: 'info', detail: 'Nginx Proxy Manager is not deployed on this node.' };
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
  // requireActive: false — same reasoning as checkNginxOnlineFailed; the
  // re-render PUT fails loudly if NPM is really down.
  const adminUrl = (await findNpmAdmin({ node, requireActive: false }))?.apiUrl;
  if (!adminUrl) {
    return { ok: false, message: 'Nginx Proxy Manager is not deployed on this node.', refresh: false };
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
  const call = (enabled: boolean) => setProxyHostEnabled(adminUrl, token, id, enabled, { timeoutMs: 8000 });
  try {
    await call(false);
    const enableRes = await call(true);
    if (!enableRes.ok) {
      logger.warn('diagnose:nginx_online_failed', `re-enable id=${id} (${itemId}) returned HTTP ${enableRes.status}: ${enableRes.body.slice(0, 200)}`);
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
