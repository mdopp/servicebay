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
 *     and returns its `http://localhost:<adminPort>` URL, or null when
 *     nginx isn't installed/active.
 *   - `getNpmToken(adminUrl)` — tries stored creds first, then the
 *     wizard's default (`admin@example.com`/`changeme`); returns null
 *     if all candidates 401.
 */
import { getConfig } from '../../config';
import { ServiceManager } from '../../services/ServiceManager';

/** Locate the running nginx-web service on `node` and return its admin URL.
 *  Returns null when nginx-web isn't installed or its admin port can't
 *  be derived from the service manifest. */
export async function findNpmAdminUrl(node: string): Promise<string | null> {
  try {
    const services = await ServiceManager.listServices(node);
    const nginx = services.find(
      s => s.name === 'nginx' || s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
    );
    if (!nginx?.active) return null;
    const ports = (nginx.ports ?? [])
      .map(p => parseInt(String(p.host ?? ''), 10))
      .filter(p => Number.isFinite(p) && p !== 80 && p !== 443);
    return `http://localhost:${ports[0] ?? 81}`;
  } catch {
    return null;
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
