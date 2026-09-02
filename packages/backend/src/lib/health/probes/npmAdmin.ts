/**
 * The certificate→proxy-host link (#2594). NPM keeps certificates and
 * proxy hosts in two independent tables; deleting a host leaves its
 * certificate behind with nothing pointing at it. Everything that wants
 * to know "is this cert still serving anything?" asks here.
 *
 * Locating NPM and minting a token used to live here too; since #2730
 * that is `lib/npm/client.ts` (`resolveNpmAdmin` / `getNpmToken`).
 */

// ─── Certificate → proxy-host binding (#2594) ───────────────────────────

/** The bit of an NPM certificate row the binding check needs. */
export interface NpmCertRef {
  id: number;
  domain_names?: string[];
}

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

/** Pure indexer over a `GET /api/nginx/proxy-hosts` response body.
 *  Disabled hosts count as bindings: the operator switched the route
 *  off, they did not give the domain up, and re-enabling it must not
 *  find the certificate deleted underneath. */
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
    const res = await fetch(`${adminUrl}/api/nginx/proxy-hosts`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return indexProxyHostBindings(await res.json());
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
 *  of the test — see `certExpiry.ts`, which only ever acts on an unbound
 *  cert once it is inside the expiry window. */
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
    const res = await fetch(`${adminUrl}/api/nginx/certificates/${certId}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 404) return { kind: 'unknown', reason: `NPM has no certificate ${certId} any more.` };
    if (!res.ok) return { kind: 'unknown', reason: `NPM certificate lookup returned HTTP ${res.status}.` };
    cert = (await res.json()) as NpmCertRef;
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
