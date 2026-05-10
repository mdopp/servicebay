/**
 * `dangling_proxy` probe — surfaces NPM proxy hosts whose forward target
 * isn't backed by any managed service or running container. The
 * detection itself lives inline in the diagnose route (it needs the
 * digital twin); this module only registers the per-item
 * `delete_route` action (#251) so each row in the items list gets a
 * "Delete route" button.
 *
 * itemId is the host's primary domain (server_name from the digital
 * twin). The action handler queries NPM's GET /api/nginx/proxy-hosts
 * to map the domain back to NPM's numeric id, then DELETEs by id.
 * Earlier versions tried to read the id straight from the digital
 * twin (`server._id`), but the agent doesn't actually populate that
 * field — twin proxy entries come from parsing nginx config files
 * on disk, which don't carry NPM's primary key. Looking the id up
 * at dispatch time keeps the action working end-to-end.
 */

import { getConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'dangling_proxy';

/** Locate NPM's admin URL on the given node. Returns null when nginx
 *  isn't deployed or its admin port can't be derived. Mirrors the
 *  helper in npmDataStale.ts but kept local to avoid coupling. */
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
 *  token, or null when nothing works. */
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

/**
 * Map a domain (server_name) to NPM's numeric proxy_host id by
 * fetching the host list. Returns null when no host matches the
 * domain, or the request fails.
 */
async function resolveProxyHostId(adminUrl: string, token: string, domain: string): Promise<number | null> {
  try {
    const res = await fetch(`${adminUrl}/api/nginx/proxy-hosts?expand=owner`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const hosts = await res.json() as Array<{ id?: number; domain_names?: string[] }>;
    if (!Array.isArray(hosts)) return null;
    for (const h of hosts) {
      const names = h.domain_names ?? [];
      if (names.includes(domain) && typeof h.id === 'number') return h.id;
    }
    return null;
  } catch {
    return null;
  }
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
  const adminUrl = await findNpmAdminUrl(node);
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
  const id = await resolveProxyHostId(adminUrl, token, itemId);
  if (id === null) {
    return {
      ok: false,
      message: `Couldn't find an NPM proxy host for ${itemId} — it may have been deleted between the probe run and your click.`,
      refresh: true,
    };
  }
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
      'Removes this proxy host from Nginx Proxy Manager. The forward target is no longer backed by a managed service, so the route is just dead config — but the deletion is permanent. Re-create from a service template if you change your mind.',
    destructive: true,
  },
  deleteRoute,
);
