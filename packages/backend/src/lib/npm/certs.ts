/**
 * NPM certificate table (`/api/nginx/certificates`) — the typed client
 * (#2731), plus the certificate→proxy-host link (#2594).
 *
 * NPM keeps certificates and proxy hosts in two independent tables;
 * deleting a host leaves its certificate behind with nothing pointing at
 * it. Everything that wants to know "is this cert still serving anything?"
 * asks `isCertOrphaned` / `classifyCertBinding` here.
 */
import { npmRequest, toResult, toStatus, type NpmResult, type NpmStatus } from './http';
import { listProxyHosts } from './proxyHosts';

/** The NPM certificate row, as far as ServiceBay reads it. */
export interface NpmCertificate {
  id: number;
  provider?: string;
  domain_names?: string[];
  /** ISO timestamp, or null while issuance is pending. */
  expires_on?: string | null;
  nice_name?: string;
}

/** The bit of a certificate row the binding check needs. */
export interface NpmCertRef {
  id: number;
  domain_names?: string[];
}

interface CallOptions {
  timeoutMs?: number;
}

export async function listCertificates(
  apiUrl: string,
  token: string,
  opts: CallOptions & { expand?: 'owner'[] } = {},
): Promise<NpmResult<NpmCertificate[]>> {
  const query = opts.expand?.length ? `?expand=${opts.expand.join(',')}` : '';
  const res = await npmRequest(apiUrl, `/api/nginx/certificates${query}`, { token, timeoutMs: opts.timeoutMs });
  return toResult<NpmCertificate[]>(res);
}

export async function getCertificate(
  apiUrl: string,
  token: string,
  id: number | string,
  opts: CallOptions = {},
): Promise<NpmResult<NpmCertificate>> {
  const res = await npmRequest(apiUrl, `/api/nginx/certificates/${id}`, { token, timeoutMs: opts.timeoutMs });
  return toResult<NpmCertificate>(res);
}

/** Budget for an ACME exchange: NPM blocks until Let's Encrypt either
 *  issues or gives up. */
export const CERT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Ask NPM to issue a Let's Encrypt certificate (webroot HTTP-01). The
 * proxy host MUST already exist — the challenge file is served on port 80
 * across the configured server_names, so without a match NPM's default
 * server rejects the ACME request and certbot times out.
 *
 * Schema note: recent NPM tightened the certificate `meta` schema with
 * `additionalProperties: false` and dropped `letsencrypt_email` /
 * `letsencrypt_agree`; the ACME email comes from the owner user's account
 * (set by the bootstrap `PUT /api/users/1`). Sending the legacy fields makes
 * NPM 400.
 */
export async function requestLetsEncryptCert(
  apiUrl: string,
  token: string,
  domain: string,
  opts: CallOptions = {},
): Promise<NpmResult<NpmCertificate>> {
  const res = await npmRequest(apiUrl, '/api/nginx/certificates', {
    method: 'POST',
    token,
    body: { provider: 'letsencrypt', domain_names: [domain], meta: { dns_challenge: false } },
    timeoutMs: opts.timeoutMs ?? CERT_REQUEST_TIMEOUT_MS,
  });
  return toResult<NpmCertificate>(res);
}

export async function renewCertificate(
  apiUrl: string,
  token: string,
  id: number | string,
  opts: CallOptions = {},
): Promise<NpmStatus> {
  const res = await npmRequest(apiUrl, `/api/nginx/certificates/${id}/renew`, {
    method: 'POST',
    token,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  return toStatus(res);
}

export async function deleteCertificate(
  apiUrl: string,
  token: string,
  id: number | string,
  opts: CallOptions = {},
): Promise<NpmStatus> {
  const res = await npmRequest(apiUrl, `/api/nginx/certificates/${id}`, {
    method: 'DELETE',
    token,
    timeoutMs: opts.timeoutMs,
  });
  return toStatus(res);
}

/** Bind a certificate to a proxy host and make HTTPS canonical. The PUT
 *  names only the SSL fields, so exposure / auth / upstream are untouched. */
export async function bindCertToProxyHost(
  apiUrl: string,
  token: string,
  hostId: number,
  certId: number,
  opts: CallOptions = {},
): Promise<NpmStatus> {
  const res = await npmRequest(apiUrl, `/api/nginx/proxy-hosts/${hostId}`, {
    method: 'PUT',
    token,
    body: { certificate_id: certId, ssl_forced: true, http2_support: true, hsts_enabled: false },
    timeoutMs: opts.timeoutMs,
  });
  return toStatus(res);
}

// ─── Certificate → proxy-host binding (#2594) ───────────────────────────

/** Everything NPM's proxy-host table currently points at, indexed both
 *  ways: by the certificate id a host selected, and by the domain a host
 *  serves. Two keys, not one, on purpose — a duplicate certificate for a
 *  domain that IS served (by some other cert row) must not read as
 *  unused. See `isCertOrphaned`. */
export interface ProxyHostBindings {
  /** `certificate_id` values referenced by at least one proxy host. */
  certIds: Set<number>;
  /** Every domain served by a proxy host, lower-cased. */
  domains: Set<string>;
}

/** Pure indexer over a proxy-host list. Disabled hosts count as
 *  bindings: the operator switched the route off, they did not give the
 *  domain up, and re-enabling it must not find the certificate deleted
 *  underneath. */
export function indexProxyHostBindings(hosts: unknown): ProxyHostBindings {
  const certIds = new Set<number>();
  const domains = new Set<string>();
  for (const raw of Array.isArray(hosts) ? hosts : []) {
    const host = raw as { certificate_id?: unknown; domain_names?: unknown };
    const certId = Number(host.certificate_id);
    if (Number.isFinite(certId) && certId > 0) certIds.add(certId);
    for (const d of Array.isArray(host.domain_names) ? host.domain_names : []) {
      if (typeof d === 'string' && d.trim()) domains.add(d.trim().toLowerCase());
    }
  }
  return { certIds, domains };
}

/** Read NPM's proxy-host table and index it. Returns `null` — not an
 *  empty index — when the table could not be read, so callers can tell
 *  "nothing is bound" from "we don't know what is bound". Every caller
 *  must treat `null` as "assume in use" (see `isCertOrphaned`): the two
 *  mistakes are not symmetric, offering a renewal for a dead cert is
 *  noise, offering a delete for a live one takes a site down. */
export async function fetchProxyHostBindings(
  adminUrl: string,
  token: string,
): Promise<ProxyHostBindings | null> {
  try {
    const r = await listProxyHosts(adminUrl, token, { timeoutMs: 6000 });
    if (!r.ok) return null;
    return indexProxyHostBindings(r.data);
  } catch {
    return null;
  }
}

/** True when nothing in NPM's proxy-host table uses this certificate:
 *  no host selected it by id, and no host serves any domain it covers.
 *
 *  Deliberately conservative in three places:
 *   - `bindings === null` (host table unreadable) → not orphaned.
 *   - a cert with no domain names → not orphaned (nothing to compare).
 *   - a wildcard cert matches any host domain under it, so `*.x.tld`
 *     counts as in use while `a.x.tld` is served, even by another cert.
 *
 *  Note what this does NOT decide on its own: a certificate provisioned
 *  *ahead* of its route is unbound too. The caller adds the second half
 *  of the test — see `health/probes/certExpiry.ts`, which only ever acts
 *  on an unbound cert once it is inside the expiry window. */
export function isCertOrphaned(cert: NpmCertRef, bindings: ProxyHostBindings | null): boolean {
  if (!bindings) return false;
  if (bindings.certIds.has(cert.id)) return false;
  const domains = (cert.domain_names ?? [])
    .filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
    .map(d => d.trim().toLowerCase());
  if (domains.length === 0) return false;
  return !domains.some(d => (d.startsWith('*.')
    ? [...bindings.domains].some(h => h === d.slice(2) || h.endsWith(d.slice(1)))
    : bindings.domains.has(d)));
}

/** Verdict for one certificate id, resolved live against NPM. */
export type CertBindingVerdict =
  | { kind: 'in-use'; domains: string[] }
  | { kind: 'orphaned'; domains: string[] }
  | { kind: 'unknown'; reason: string };

/** Re-derive a single certificate's binding state at click time.
 *  The `cert_expiry` item list is up to an hour old, so an action that
 *  depends on "this cert belongs to nothing" must confirm it against
 *  NPM before it does anything — a route may have been created in the
 *  meantime. Anything it cannot read comes back `unknown`, never a
 *  guess. */
export async function classifyCertBinding(
  adminUrl: string,
  token: string,
  certId: string,
): Promise<CertBindingVerdict> {
  let cert: NpmCertRef;
  try {
    const r = await getCertificate(adminUrl, token, certId, { timeoutMs: 6000 });
    if (r.status === 404) return { kind: 'unknown', reason: `NPM has no certificate ${certId} any more.` };
    if (!r.ok) return { kind: 'unknown', reason: `NPM certificate lookup returned HTTP ${r.status}.` };
    cert = r.data;
  } catch (e) {
    return { kind: 'unknown', reason: `Could not read certificate ${certId} from NPM: ${e instanceof Error ? e.message : String(e)}` };
  }
  const bindings = await fetchProxyHostBindings(adminUrl, token);
  if (!bindings) return { kind: 'unknown', reason: 'Could not read the NPM proxy-host list.' };
  const domains = (cert.domain_names ?? []).filter((d): d is string => typeof d === 'string');
  const id = Number.isFinite(Number(cert.id)) ? Number(cert.id) : Number(certId);
  return isCertOrphaned({ id, domain_names: domains }, bindings)
    ? { kind: 'orphaned', domains }
    : { kind: 'in-use', domains };
}
