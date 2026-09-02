/**
 * `dangling_proxy` probe — surfaces NPM proxy hosts whose forward target
 * isn't backed by any managed service or running container. The
 * detection itself lives inline in the diagnose route (it needs the
 * digital twin); this module registers the per-item actions so each row
 * in the items list gets the button its situation earns: `delete_route`
 * (#251) when the target is gone, `repoint_route` (#2611) when the
 * service is alive and only its published port moved.
 *
 * itemId is the host's primary domain (server_name from the digital
 * twin). The action handler queries NPM's GET /api/nginx/proxy-hosts
 * to map the domain back to NPM's numeric id, then DELETEs (or PUTs)
 * by id. Earlier versions tried to read the id straight from the digital
 * twin (`server._id`), but the agent doesn't actually populate that
 * field — twin proxy entries come from parsing nginx config files
 * on disk, which don't carry NPM's primary key. Looking the id up
 * at dispatch time keeps the action working end-to-end.
 *
 * Both handlers re-derive the route's state before they act (#2594's
 * pattern): the row they were clicked from can be up to an hour old, and
 * the two actions point opposite ways. `delete_route` refuses once the
 * owning service turns out to be alive — deleting there costs the
 * operator a working subdomain and its certificate binding — and
 * `repoint_route` refuses unless the port really did move.
 */

import { getConfig } from '@/lib/config';
import { getNodeTwin } from '@/lib/store/repository';
import { logger } from '@/lib/logger';
import { findNpmAdmin, getNpmToken } from '@/lib/npm/client';
import { registerProbeAction, type ProbeActionResult } from '../actions';
import {
  classifyDanglingRoute,
  type DanglingRouteVerdict,
  type RouteOwner,
  type RouteTargetService,
} from './danglingRouteState';

const PROBE_ID = 'dangling_proxy';

/** The bit of an NPM proxy-host row both actions need. */
interface NpmProxyHostRef {
  id: number;
  forward_host?: string;
  forward_port?: number;
}

/**
 * Map a domain (server_name) to its NPM proxy_host row by fetching the
 * host list. Returns null when no host matches the domain, or the
 * request fails.
 */
async function resolveProxyHost(adminUrl: string, token: string, domain: string): Promise<NpmProxyHostRef | null> {
  try {
    const res = await fetch(`${adminUrl}/api/nginx/proxy-hosts?expand=owner`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const hosts = await res.json() as Array<NpmProxyHostRef & { domain_names?: string[] }>;
    if (!Array.isArray(hosts)) return null;
    for (const h of hosts) {
      const names = h.domain_names ?? [];
      if (names.includes(domain) && typeof h.id === 'number') {
        return { id: h.id, forward_host: h.forward_host, forward_port: h.forward_port };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Re-run the #2611 classification for one domain against what the node
 * looks like *now*, not what the probe row recorded. Returns null when
 * the state can't be established (unknown domain, twin not populated) —
 * callers must treat that as "don't act", never as a guess.
 */
async function currentVerdictFor(
  node: string,
  domain: string,
  currentPort: number | undefined,
  currentHost: string | undefined,
): Promise<DanglingRouteVerdict | null> {
  if (typeof currentPort !== 'number') return null;
  const owners: RouteOwner[] = ((await getConfig()).reverseProxy?.hosts ?? [])
    .map(h => ({ domain: h.domain, service: h.service }));
  const twin = getNodeTwin(node);
  const services: RouteTargetService[] = ((twin?.services ?? []) as Array<{ name?: string; ports?: RouteTargetService['ports'] }>)
    .filter((s): s is { name: string; ports?: RouteTargetService['ports'] } => typeof s.name === 'string')
    .map(s => ({ name: s.name, ports: s.ports }));
  if (services.length === 0) return null;
  return classifyDanglingRoute({ domain, targetHost: currentHost, targetPort: currentPort }, owners, services);
}

/** Resolve NPM admin URL + token, or the reason we couldn't. Shared by
 *  both actions so the two failure messages stay identical. */
async function connectToNpm(node: string): Promise<{ adminUrl: string; token: string } | ProbeActionResult> {
  // requireActive: false — the twin's `active` flag lies for the kube nginx
  // pod (#496); if NPM is really down the API call below fails with the
  // precise reason instead of a misleading "not deployed".
  const npm = await findNpmAdmin({ node, requireActive: false });
  const adminUrl = npm?.apiUrl;
  if (!adminUrl) {
    return {
      ok: false,
      message: 'Nginx Proxy Manager is not deployed on this node.',
      refresh: false,
    };
  }
  const token = await getNpmToken(adminUrl);
  if (!token) {
    return {
      ok: false,
      message: 'Could not authenticate against NPM. If a stale-credentials probe is also showing, fix that first.',
      refresh: false,
    };
  }
  return { adminUrl, token };
}

async function deleteRoute({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No domain supplied — cannot delete.', refresh: false };
  }
  const conn = await connectToNpm(node);
  if ('ok' in conn) return conn;
  const { adminUrl, token } = conn;
  const host = await resolveProxyHost(adminUrl, token, itemId);
  if (host === null) {
    return {
      ok: false,
      message: `Couldn't find an NPM proxy host for ${itemId} — it may have been deleted between the probe run and your click.`,
      refresh: true,
    };
  }
  // #2611 — refuse when the owning service turned out to be alive. The
  // row can be an hour old; deleting a route whose service merely moved
  // port costs the operator the subdomain and its certificate binding to
  // fix a wrong number.
  const verdict = await currentVerdictFor(node, itemId, host.forward_port, host.forward_host);
  if (verdict && verdict.kind !== 'target-gone') {
    return { ok: false, message: refusalForLiveService(itemId, verdict), refresh: true };
  }
  return performProxyHostDelete(adminUrl, token, host.id, itemId);
}

/** Why a delete was refused, in terms of what the operator should do. */
function refusalForLiveService(domain: string, verdict: DanglingRouteVerdict): string {
  switch (verdict.kind) {
    case 'port-moved':
      return `Not deleted: ${verdict.service} is running and publishes ${verdict.to} — the route is on the wrong port, not orphaned. Use "Repoint route" so ${domain} and its certificate survive.`;
    case 'port-ambiguous':
      return `Not deleted: ${verdict.service} is running and publishes ${verdict.candidates.join(', ')} — the route points at none of them, but the service is alive. Set the right port on the service page rather than giving up ${domain}.`;
    case 'service-silent':
      return `Not deleted: ${verdict.service} still exists, it just publishes no port right now. Fix the service — deleting ${domain} would cost you the domain as well.`;
    case 'target-gone':
      return `Not deleted: the state of ${domain} changed since the check ran.`;
  }
}

/**
 * #2611 — move a route onto the port its service publishes now.
 *
 * Only ever PUTs `forward_port` (plus `forward_host` when the service
 * moved to a loopback-only bind), so exposure (access_list), auth
 * (advanced_config / forward-auth) and the bound certificate are
 * untouched — the same narrow patch `reconcileProxyHostUpstream` uses on
 * the install path.
 */
async function repointRoute({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No domain supplied — cannot repoint.', refresh: false };
  }
  const conn = await connectToNpm(node);
  if ('ok' in conn) return conn;
  const { adminUrl, token } = conn;
  const host = await resolveProxyHost(adminUrl, token, itemId);
  if (host === null) {
    return {
      ok: false,
      message: `Couldn't find an NPM proxy host for ${itemId} — it may have been deleted between the probe run and your click.`,
      refresh: true,
    };
  }
  const verdict = await currentVerdictFor(node, itemId, host.forward_port, host.forward_host);
  if (!verdict) {
    return {
      ok: false,
      message: `Could not establish where ${itemId} should point right now — the node's service list is not available. Re-run the check in a minute.`,
      refresh: false,
    };
  }
  if (verdict.kind !== 'port-moved') {
    return { ok: false, message: refusalForRepoint(itemId, verdict), refresh: true };
  }
  const patch: { forward_port: number; forward_host?: string } = { forward_port: verdict.to };
  if (verdict.forwardHost && verdict.forwardHost !== host.forward_host) {
    patch.forward_host = verdict.forwardHost;
  }
  return performProxyHostRepoint(adminUrl, token, host, patch, itemId, verdict.service);
}

/** Why a repoint was refused — always names the state that replaced
 *  "the port moved", so the operator isn't left guessing. */
function refusalForRepoint(domain: string, verdict: DanglingRouteVerdict): string {
  switch (verdict.kind) {
    case 'port-ambiguous':
      return `Not repointed: ${verdict.service} publishes ${verdict.candidates.join(', ')} and none of them is the obvious replacement. Pick one on the service page — guessing would send ${domain} to the wrong process.`;
    case 'service-silent':
      return `Not repointed: ${verdict.service} publishes no port right now, so there is nothing to point ${domain} at. Start the service first.`;
    case 'target-gone':
      return `Not repointed: ${domain} has no live service behind it any more — this is now a "Delete route" case.`;
    case 'port-moved':
      return `Not repointed: the state of ${domain} changed since the check ran.`;
  }
}

/** Issue the narrow NPM PUT for a repoint and map the outcome. Split out
 *  of repointRoute to keep it under the function-length budget. */
async function performProxyHostRepoint(
  adminUrl: string,
  token: string,
  host: NpmProxyHostRef,
  patch: { forward_port: number; forward_host?: string },
  domain: string,
  service: string,
): Promise<ProbeActionResult> {
  const from = `${host.forward_host ?? '?'}:${host.forward_port ?? '?'}`;
  const to = `${patch.forward_host ?? host.forward_host ?? '?'}:${patch.forward_port}`;
  try {
    const res = await fetch(`${adminUrl}/api/nginx/proxy-hosts/${host.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('diagnose:dangling_proxy', `PUT id=${host.id} (${domain}) returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      return {
        ok: false,
        message: `NPM returned HTTP ${res.status} when repointing ${domain} to ${to}.`,
        refresh: false,
      };
    }
    logger.info('diagnose:dangling_proxy', `Repointed ${domain}: ${from} → ${to} (service ${service})`);
    return {
      ok: true,
      message: `${domain} now forwards to ${to} instead of ${from} — the port ${service} actually publishes. Certificate and exposure are unchanged.`,
      refresh: true,
    };
  } catch (e) {
    return {
      ok: false,
      message: `Failed to reach NPM: ${e instanceof Error ? e.message : String(e)}`,
      refresh: false,
    };
  }
}

/** Issue the NPM DELETE for a resolved proxy host id and map the outcome
 *  to a ProbeActionResult. Split out of deleteRoute to keep it under the
 *  function-length budget. */
async function performProxyHostDelete(
  adminUrl: string,
  token: string,
  id: number,
  itemId: string,
): Promise<ProbeActionResult> {
  try {
    const res = await fetch(`${adminUrl}/api/nginx/proxy-hosts/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('diagnose:dangling_proxy', `DELETE id=${id} (${itemId}) returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      return {
        ok: false,
        message: `NPM returned HTTP ${res.status} when deleting ${itemId}.`,
        refresh: false,
      };
    }
    return {
      ok: true,
      message: `Route ${itemId} removed.`,
      refresh: true,
    };
  } catch (e) {
    return {
      ok: false,
      message: `Failed to reach NPM: ${e instanceof Error ? e.message : String(e)}`,
      refresh: false,
    };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'delete_route',
    label: 'Delete route',
    description:
      'Removes this proxy host from Nginx Proxy Manager. Offered only where the service behind the domain is gone or publishes nothing, so the route is dead config. It is permanent: the domain stops resolving to anything here and its certificate binding goes with it, so getting it back means re-creating the route and re-issuing the certificate. If the service turns out to be alive when you click, the deletion is refused.',
    destructive: true,
  },
  deleteRoute,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'repoint_route',
    label: 'Repoint route',
    description:
      'Moves this route onto the port its service publishes now — the port changed on a redeploy and the route was left behind. Only the forward target is changed: the domain, its certificate and its exposure stay exactly as they are, and nothing is deleted.',
  },
  repointRoute,
);
