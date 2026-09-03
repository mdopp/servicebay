/**
 * NPM proxy-host table (`/api/nginx/proxy-hosts`) — the typed client (#2731).
 *
 * Thin, one function per endpoint verb, returning `NpmResult`/`NpmStatus`
 * so the caller decides what a non-ok status means for it. Policy —
 * reconcile-vs-create, what a 400 on create means, which fields a PUT may
 * touch — lives with the callers (`lib/reverseProxy/proxyHostProvisioning.ts`,
 * the diagnose probes), not here.
 */
import { npmRequest, toResult, toStatus, type NpmResult, type NpmStatus } from './http';

/** The NPM proxy-host row, as far as ServiceBay reads it. */
export interface NpmProxyHost {
  id: number;
  domain_names?: string[];
  forward_host?: string;
  forward_port?: number;
  forward_scheme?: string;
  certificate_id?: number;
  access_list_id?: number;
  enabled?: boolean | number;
  advanced_config?: string;
  meta?: NpmProxyHostMeta;
}

/** NPM sets these after every `nginx -t`/reload: a conf nginx refused
 *  flips `nginx_online` false and stashes the `[emerg]` text in
 *  `nginx_err` — while the create/update call already answered 200. */
export interface NpmProxyHostMeta {
  nginx_online?: boolean;
  nginx_err?: string | null;
}

/** Fields a create POST carries. Mirrors NPM's schema; the defaults are
 *  the provisioning module's business. */
export interface NpmProxyHostCreate {
  domain_names: string[];
  forward_host?: string;
  forward_port: number;
  forward_scheme: string;
  enabled: boolean;
  allow_websocket_upgrade: boolean;
  block_exploits: boolean;
  caching_enabled: boolean;
  http2_support: boolean;
  ssl_forced: boolean;
  hsts_enabled: boolean;
  hsts_subdomains: boolean;
  access_list_id: number;
  certificate_id: number;
  meta: { letsencrypt_agree: boolean; dns_challenge: boolean };
  advanced_config: string;
  locations: unknown[];
}

/** A partial row for PUT. NPM merges it into the existing record, so a
 *  patch that names only `forward_host`/`forward_port` leaves the cert,
 *  access list and advanced_config untouched. */
export type NpmProxyHostPatch = Partial<Omit<NpmProxyHost, 'id' | 'meta'>>;

export type ProxyHostExpand = 'owner' | 'access_list' | 'certificate';

interface CallOptions {
  timeoutMs?: number;
}

function expandQuery(expand?: ProxyHostExpand[]): string {
  return expand?.length ? `?expand=${expand.join(',')}` : '';
}

/** GET the whole table. `expand` is passed through verbatim — tests that
 *  stub `fetch` key on the exact URL each caller has always sent. */
export async function listProxyHosts(
  apiUrl: string,
  token: string,
  opts: CallOptions & { expand?: ProxyHostExpand[] } = {},
): Promise<NpmResult<NpmProxyHost[]>> {
  const res = await npmRequest(apiUrl, `/api/nginx/proxy-hosts${expandQuery(opts.expand)}`, {
    token,
    timeoutMs: opts.timeoutMs,
  });
  return toResult<NpmProxyHost[]>(res);
}

export async function getProxyHost(
  apiUrl: string,
  token: string,
  id: number,
  opts: CallOptions = {},
): Promise<NpmResult<NpmProxyHost>> {
  const res = await npmRequest(apiUrl, `/api/nginx/proxy-hosts/${id}`, { token, timeoutMs: opts.timeoutMs });
  return toResult<NpmProxyHost>(res);
}

/** The row whose `domain_names` include `domain`, or `null` when no row
 *  does — and `null` too when the table could not be read: every caller
 *  treats "unknown" as "not there" and re-checks on its next step. */
export async function findProxyHostByDomain(
  apiUrl: string,
  token: string,
  domain: string,
  opts: CallOptions & { expand?: ProxyHostExpand[] } = {},
): Promise<NpmProxyHost | null> {
  try {
    const r = await listProxyHosts(apiUrl, token, opts);
    if (!r.ok || !Array.isArray(r.data)) return null;
    return r.data.find(h => Array.isArray(h.domain_names) && h.domain_names.includes(domain)) ?? null;
  } catch {
    return null;
  }
}

export async function createProxyHost(
  apiUrl: string,
  token: string,
  body: NpmProxyHostCreate,
  opts: CallOptions = {},
): Promise<NpmResult<NpmProxyHost>> {
  const res = await npmRequest(apiUrl, '/api/nginx/proxy-hosts', {
    method: 'POST',
    token,
    body,
    timeoutMs: opts.timeoutMs,
  });
  return toResult<NpmProxyHost>(res);
}

export async function updateProxyHost(
  apiUrl: string,
  token: string,
  id: number,
  patch: NpmProxyHostPatch,
  opts: CallOptions = {},
): Promise<NpmStatus> {
  const res = await npmRequest(apiUrl, `/api/nginx/proxy-hosts/${id}`, {
    method: 'PUT',
    token,
    body: patch,
    timeoutMs: opts.timeoutMs,
  });
  return toStatus(res);
}

export async function deleteProxyHost(
  apiUrl: string,
  token: string,
  id: number,
  opts: CallOptions = {},
): Promise<NpmStatus> {
  const res = await npmRequest(apiUrl, `/api/nginx/proxy-hosts/${id}`, {
    method: 'DELETE',
    token,
    timeoutMs: opts.timeoutMs,
  });
  return toStatus(res);
}

/** `POST …/{id}/enable` or `…/disable`. A disable→enable pair makes NPM
 *  regenerate and reload the host's conf. */
export async function setProxyHostEnabled(
  apiUrl: string,
  token: string,
  id: number,
  enabled: boolean,
  opts: CallOptions = {},
): Promise<NpmStatus> {
  const res = await npmRequest(apiUrl, `/api/nginx/proxy-hosts/${id}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
    token,
    timeoutMs: opts.timeoutMs,
  });
  return toStatus(res);
}

/**
 * Pure decision over a host's meta: only `nginx_online === false` is a
 * definite failure. `undefined`/`true` (older NPM, or the status not yet
 * computed) stays online, fail-open.
 */
export function decideNginxOnline(
  meta: NpmProxyHostMeta | undefined,
): { online: boolean; err?: string } {
  if (meta?.nginx_online === false) {
    return { online: false, err: (meta.nginx_err ?? '').trim() || 'nginx reverted the conf (no error text recorded)' };
  }
  return { online: true };
}

/**
 * #2156 — NPM returns HTTP 200 the instant it writes a host's DB row, but
 * `meta.nginx_online` only flips true once nginx actually loaded the
 * generated conf. Read the live row so a create that nginx then reverted
 * is not reported green. Fail-open: an unreadable status is `online`.
 */
export async function checkNginxOnline(
  apiUrl: string,
  token: string,
  hostId: number,
): Promise<{ online: boolean; err?: string }> {
  try {
    const r = await getProxyHost(apiUrl, token, hostId);
    if (!r.ok) return { online: true };
    return decideNginxOnline(r.data.meta);
  } catch {
    return { online: true };
  }
}
