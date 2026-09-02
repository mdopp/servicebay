/**
 * NPM access lists (`/api/nginx/access-lists`) — the typed client (#2731)
 * and the one list ServiceBay manages itself: "ServiceBay LAN only".
 */
import { logger } from '../logger';
import { npmRequest, toResult, type NpmResult } from './http';

export interface NpmAccessListClient {
  address: string;
  directive: 'allow' | 'deny' | string;
}

export interface NpmAccessList {
  id: number;
  name: string;
  clients?: NpmAccessListClient[];
}

export interface NpmAccessListCreate {
  name: string;
  satisfy_any: boolean;
  pass_auth: boolean;
  items: unknown[];
  clients: NpmAccessListClient[];
}

/** Name of the auto-managed LAN-only access list in NPM. The
 *  GET-then-POST flow keys off this exact string, so don't change it
 *  without a migration plan — renaming would orphan the existing list
 *  and create a duplicate. */
export const LAN_ACCESS_LIST_NAME = 'ServiceBay LAN only';

export async function listAccessLists(
  apiUrl: string,
  token: string,
  opts: { expand?: 'clients'[]; timeoutMs?: number } = {},
): Promise<NpmResult<NpmAccessList[]>> {
  const query = opts.expand?.length ? `?expand=${opts.expand.join(',')}` : '';
  const res = await npmRequest(apiUrl, `/api/nginx/access-lists${query}`, { token, timeoutMs: opts.timeoutMs });
  return toResult<NpmAccessList[]>(res);
}

export async function createAccessList(
  apiUrl: string,
  token: string,
  body: NpmAccessListCreate,
  opts: { timeoutMs?: number } = {},
): Promise<NpmResult<NpmAccessList>> {
  const res = await npmRequest(apiUrl, '/api/nginx/access-lists', {
    method: 'POST',
    token,
    body,
    timeoutMs: opts.timeoutMs,
  });
  return toResult<NpmAccessList>(res);
}

/**
 * Derive a /24 CIDR from a node IP. 192.168.178.100 → 192.168.178.0/24.
 * Operators on non-/24 LANs can edit the access list manually in NPM
 * admin — most home/SOHO networks are /24, so this is the right default.
 */
export function lanCidrFromIp(ip: string): string | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}.0/24`;
}

/**
 * POST a new LAN-only access list to NPM. Returns the new list's id, or
 * null on any failure (logged). The list's rules are evaluated top-down
 * with first-match-wins, so the allow-LAN/allow-localhost/deny-all order
 * is load-bearing.
 */
async function createLanAccessList(apiUrl: string, token: string, cidr: string): Promise<number | null> {
  try {
    const r = await createAccessList(apiUrl, token, {
      name: LAN_ACCESS_LIST_NAME,
      satisfy_any: false,
      pass_auth: false,
      items: [],
      clients: [
        { address: cidr, directive: 'allow' },
        { address: '127.0.0.1', directive: 'allow' },
        { address: 'all', directive: 'deny' },
      ],
    });
    if (!r.ok) {
      logger.warn('ProxyHosts', `Failed to create LAN access list: HTTP ${r.status} ${r.body.slice(0, 200)}`);
      return null;
    }
    if (typeof r.data.id !== 'number') return null;
    logger.info('ProxyHosts', `Created NPM access list "${LAN_ACCESS_LIST_NAME}" (id=${r.data.id}) allowing ${cidr} + localhost`);
    return r.data.id;
  } catch (e) {
    logger.warn('ProxyHosts', `LAN access-list create failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Ensure NPM has a "ServiceBay LAN only" access list configured for the
 * detected LAN /24, returning its id. Create-if-missing, idempotent
 * across reinstalls. Returns null on any error so the caller can fall
 * back to the previous open behaviour rather than blowing up the install.
 *
 * Used by the proxy-host loop to auto-restrict any host whose
 * `exposure: 'lan'` meta says it shouldn't be reachable from the
 * internet.
 */
export async function ensureLanAccessList(apiUrl: string, token: string, nodeIp: string): Promise<number | null> {
  const cidr = lanCidrFromIp(nodeIp);
  if (!cidr) {
    logger.warn('ProxyHosts', `Could not derive LAN CIDR from node IP ${nodeIp}; skipping access-list setup.`);
    return null;
  }

  // Look for an existing list by name. expand=clients gives us the
  // rule list so we can detect drift and patch instead of duplicating.
  try {
    const r = await listAccessLists(apiUrl, token, { expand: ['clients'] });
    if (r.ok) {
      const existing = Array.isArray(r.data) ? r.data.find(l => l.name === LAN_ACCESS_LIST_NAME) : undefined;
      if (existing) return existing.id;
    }
  } catch (e) {
    logger.warn('ProxyHosts', `LAN access-list lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    // fall through to create — worst case we'll get a duplicate-name 400
  }

  return createLanAccessList(apiUrl, token, cidr);
}
