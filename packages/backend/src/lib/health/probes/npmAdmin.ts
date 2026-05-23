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
