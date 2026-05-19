/**
 * Internal-token-aware loopback fetch helper.
 *
 * Server-side code that needs to call a local `/api/...` route must
 * attach the X-SB-Internal-Token header — proxy.ts middleware gates
 * state-changing API calls on either a session cookie OR this token
 * (the same one post-deploy scripts on the agent host use). Plain
 * Node `fetch` calls have no Origin header and would otherwise get
 * 403'd by the CSRF check.
 *
 * Three other modules currently inline this same helper
 * (`install/runner.ts`, `stackInstall/postInstall.ts`,
 * `portal/provisioner.ts`). When one of them next needs editing they
 * should reach for this shared version; in the meantime the
 * capability handlers (#629/#630) use it as the canonical path.
 */
import { getInternalApiToken } from '@/lib/auth/internalToken';

export function internalFetch(path: string, init?: RequestInit): Promise<Response> {
  const port = process.env.PORT || '3000';
  const headers = new Headers(init?.headers);
  if (!headers.has('x-sb-internal-token')) {
    headers.set('x-sb-internal-token', getInternalApiToken());
  }
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
}
