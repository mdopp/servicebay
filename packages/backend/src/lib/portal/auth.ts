/**
 * Soft-auth check for the family-portal apex page (#417).
 *
 * The portal is intentionally anonymous-readable — random visitors
 * on the LAN should still see the service tiles. But when the
 * visitor has an Authelia session (e.g. they signed into FileBrowser
 * earlier and the cookie is shared across the public domain), we
 * can render extra affordances: hide the "Request access" button,
 * greet them by name, etc.
 *
 * Implementation: server-side call into Authelia's `/api/verify`
 * forwarding the visitor's `Cookie` header. Authelia returns 200 +
 * `Remote-User` / `Remote-Name` response headers when the cookie is
 * a valid session, or 401 when it isn't (or when there's no cookie
 * at all). Either way we treat it as best-effort — a stale config
 * or unreachable Authelia just falls back to the anonymous render.
 *
 * This is the same `/api/verify` endpoint the standard NPM
 * `auth_request` integration uses (see file-share's `FILEBROWSER_SUBDOMAIN`
 * advanced_config); we just call it ourselves so we don't have to
 * thread `auth_request_set` headers through the portal proxy host
 * (which would require an NPM advanced_config update for the apex
 * and complicates the anonymous-fallback path).
 */
import { getConfig } from '@/lib/config';
import { logger } from '@/lib/logger';

const VERIFY_TIMEOUT_MS = 3_000;
const DEFAULT_AUTHELIA_PORT = '9091';

export interface PortalVisitor {
  /** LLDAP username when Authelia recognizes the cookie, otherwise null. */
  user: string | null;
  /** Display name (LLDAP firstName + lastName) when available. */
  name: string | null;
}

async function fetchAutheliaVerify(port: string, cookieHeader: string, originalUrl: string): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${port}/api/verify`, {
      headers: {
        Cookie: cookieHeader,
        ...(originalUrl ? { 'X-Original-URL': originalUrl } : {}),
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
  const publicDomain = config.reverseProxy?.publicDomain ?? config.reverseProxy?.lanDomain ?? '';
  // Probe with the `www.<domain>` subdomain, NOT the bare apex. The apex
  // (`dopp.cloud/portal`) matches no Authelia `access_control` rule, so it
  // falls through to `default_policy: deny` → 403 with no identity headers,
  // and a signed-in visitor is always seen as anonymous (#1606, #417, #1001).
  // `www.<domain>` is provisioned alongside the apex (portal/provisioner.ts)
  // and is covered by the `*.<domain>` `one_factor` wildcard rule, so an
  // authenticated cookie returns 200 + `Remote-User` / `Remote-Name`.
  const originalUrl = publicDomain ? `https://www.${publicDomain}/` : '';

  const res = await fetchAutheliaVerify(port, cookieHeader, originalUrl);
  if (!res) {
    return { user: null, name: null };
  }

  if (!res.ok) {
    if (res.status === 403) {
      logger.debug('portal:auth', `Authelia verify returned 403 (X-Original-URL=${originalUrl || '<unset>'}). Expected the *.<domain> one_factor rule to match; check session.cookies[].domain covers the public domain and the wildcard access_control rule exists.`);
    }
    return { user: null, name: null };
  }
  const user = res.headers.get('remote-user');
  const name = res.headers.get('remote-name');
  return { user: user || null, name: name || null };
}
