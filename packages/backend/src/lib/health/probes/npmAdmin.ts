/**
 * Shared NPM admin helpers used by Phase 3b runner methods
 * (`runNpmAuthCheck`, `runCertExpiryCheck`, `runCertRequestFailureCheck`).
 *
 * Hoisted out of `runner.ts` because three runner methods need them and
 * duplicating ~40 lines across three case blocks would dwarf the
 * differences. The previous Phase 3 design had each diagnose probe own
 * its own copy (see the stale note in `certRequestFailure.ts` header
 * about "house style: duplicated"); migrating into the health subsystem
 * makes a single shared home cheaper to maintain.
 *
 *   - `findNpmAdminUrl(node)` — locates the running nginx-web service
 *     and returns its `http://localhost:<adminPort>` URL, or a reason
 *     code when it can't.
 *   - `getNpmToken(adminUrl)` — tries stored creds first, then the
 *     wizard's default (`admin@example.com`/`changeme`); returns null
 *     if all candidates 401.
 *   - `fetchProxyHostBindings` / `isCertOrphaned` / `classifyCertBinding`
 *     — the certificate→host link (#2594). NPM keeps certificates and
 *     proxy hosts in two independent tables; deleting a host leaves its
 *     certificate behind with nothing pointing at it. Everything that
 *     wants to know "is this cert still serving anything?" asks here.
 */
import { getConfig } from '../../config';
import { ServiceManager } from '../../services/ServiceManager';
import { getNodeTwin } from '../../store/repository';

/**
 * Discriminated result for `findNpmAdminUrl`.
 *
 *   - `url` — nginx is in the twin and we derived its admin port.
 *   - `twin-not-ready` — the digital twin for this node hasn't been
 *     populated yet (cold-start race after the runner fires before the
 *     agent's first sync). Caller should surface this as info and let
 *     the next scheduled tick self-correct rather than cementing a
 *     misleading "not deployed" result for 5–15 min.
 *   - `nginx-not-found` — twin has data, but no nginx entry exists —
 *     genuine "NPM not installed" case.
 */
export type FindNpmAdminResult =
  | { kind: 'url'; url: string }
  | { kind: 'twin-not-ready' }
  | { kind: 'nginx-not-found' };

/** Locate the running nginx-web service on `node` and return its admin URL,
 *  or a reason code explaining why we couldn't.
 *
 *  Note: deliberately does NOT short-circuit on `service.active === false`.
 *  The `active` flag is unreliable for kube-deployed services because the
 *  matching between the template service name (`nginx`) and the
 *  systemd unit Quadlet generates (`nginx-pod.service`, container-by-
 *  container `<sha>.service`) is brittle. We trust the twin entry's
 *  presence + port mapping and let the caller's actual `fetch
 *  ${adminUrl}/api/tokens` be the source of truth — if NPM is genuinely
 *  stopped, the fetch fails with `ECONNREFUSED` and the caller surfaces
 *  the precise reason instead of a misleading "not deployed". */
export async function findNpmAdminUrl(node: string): Promise<FindNpmAdminResult> {
  try {
    const twin = getNodeTwin(node);
    if (!twin || (twin.services.length === 0 && twin.containers.length === 0)) {
      return { kind: 'twin-not-ready' };
    }
    const services = await ServiceManager.listServices(node);
    const nginx = services.find(
      s => s.name === 'nginx' || s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
    );
    if (!nginx) {
      return { kind: 'nginx-not-found' };
    }
    const ports = (nginx.ports ?? [])
      .map(p => parseInt(String(p.host ?? ''), 10))
      .filter(p => Number.isFinite(p) && p !== 80 && p !== 443);
    return { kind: 'url', url: `http://localhost:${ports[0] ?? 81}` };
  } catch {
    return { kind: 'nginx-not-found' };
  }
}

/** Try stored NPM admin creds, then the wizard defaults. Returns null
 *  when no candidate authenticates (network error or every credential
 *  came back 401). */
export async function getNpmToken(adminUrl: string): Promise<string | null> {
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
    } catch { /* try next */ }
  }
  return null;
}

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
