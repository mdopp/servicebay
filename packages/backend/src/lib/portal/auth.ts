/**
 * Soft-auth check for the family-portal apex page (#417).
 *
 * The portal is intentionally anonymous-readable — random visitors
 * on the LAN should still see the service tiles. But when the
 * visitor has an Authelia session (e.g. they signed into Home
 * Assistant earlier and the cookie is shared across the public
 * domain), we can render extra affordances: hide the "Request access"
 * button, greet them by name, etc.
 *
 * Implementation: server-side call into Authelia's
 * `/api/authz/auth-request` forwarding the visitor's `Cookie` header
 * plus an `X-Original-URL`. Authelia evaluates its access-control
 * rules against that URL and, for an authenticated session, returns
 * 200 with `Remote-User` / `Remote-Name` response headers; an
 * unauthenticated visitor gets 401. Best-effort — a stale config or
 * unreachable Authelia just falls back to the anonymous render.
 *
 * **Why a `www.` subdomain and not the apex/`/portal`:** Authelia's
 * access_control matches the bare apex (`https://<domain>/…`) against
 * no rule, so it falls through to `default_policy: deny` and returns
 * **403 — with no identity headers** even for a valid session. The
 * `*.<domain>` wildcard rule is `one_factor`, so pointing
 * `X-Original-URL` at a subdomain (`www.<domain>`, which is itself a
 * portal host) yields 200 + `Remote-User`/`Remote-Name` for a signed-in
 * visitor. Verified against the live box 2026-06-03: apex → 403,
 * `www.<domain>` → 401 anon / 200 + identity when authed. Pointing it
 * at `/portal` on the apex was why the chip never appeared (#417 / #1001
 * follow-up).
 *
 * `/api/authz/auth-request` is the nginx-flavoured forward-auth
 * endpoint (Authelia 4.38+) the rest of the proxy integration already
 * uses (see `forwardAuth.ts`); it keeps the legacy `X-Original-URL` /
 * `X-Original-Method` header API and returns 401 (not a 302) for the
 * unauthenticated case. We call it ourselves rather than thread
 * `auth_request_set` headers through the portal proxy host.
 */
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

const VERIFY_TIMEOUT_MS = 3_000;
const DEFAULT_AUTHELIA_PORT = '9091';
const AUTH_REQUEST_PATH = '/api/authz/auth-request';

export interface PortalVisitor {
  /** LLDAP username when Authelia recognizes the cookie, otherwise null. */
  user: string | null;
  /** Display name (LLDAP firstName + lastName) when available. */
  name: string | null;
}

async function fetchAutheliaVerify(port: string, cookieHeader: string, originalUrl: string): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${port}${AUTH_REQUEST_PATH}`, {
      headers: {
        Cookie: cookieHeader,
        ...(originalUrl ? { 'X-Original-URL': originalUrl, 'X-Original-Method': 'GET' } : {}),
      },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (e) {
    logger.debug('portal:auth', `Could not verify Authelia session: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function verifyAutheliaSession(cookieHeader: string | null): Promise<PortalVisitor> {
  if (!cookieHeader) {
    return { user: null, name: null };
  }
  const config = await getConfig();
  const port = config.templateSettings?.AUTHELIA_PORT ?? DEFAULT_AUTHELIA_PORT;
  const domain = config.reverseProxy?.publicDomain ?? config.reverseProxy?.lanDomain ?? '';
  // Point at the `www.` subdomain (covered by the `*.<domain>` one_factor
  // wildcard rule), NOT the bare apex which evaluates to default-deny → 403
  // and never carries identity headers. https scheme is mandatory — Authelia
  // rejects `http://` X-Original-URL with a 400 ("insecure scheme") so the
  // session cookie is only transmitted over TLS.
  const originalUrl = domain ? `https://www.${domain}/` : '';

  const res = await fetchAutheliaVerify(port, cookieHeader, originalUrl);
  if (!res) {
    return { user: null, name: null };
  }

  if (!res.ok) {
    if (res.status === 403) {
      // 403 here means the wildcard one_factor rule we expect on
      // `www.<domain>` isn't matching — the request fell through to
      // default-deny. Most likely the access_control rules don't yet
      // cover this domain (fresh install / pre-SSO).
      logger.debug('portal:auth', `Authelia auth-request returned 403 (X-Original-URL=${originalUrl || '<unset>'}). Expected a one_factor rule for *.${domain}; falling back to anonymous render.`);
    }
    return { user: null, name: null };
  }
  const user = res.headers.get('remote-user');
  const name = res.headers.get('remote-name');
  return { user: user || null, name: name || null };
}
