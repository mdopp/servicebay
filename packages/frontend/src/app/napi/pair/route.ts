import { NextRequest, NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { createPairingCode } from '@/lib/auth/pairingCodes';
import { logger } from '@/lib/logger';

/**
 * POST /napi/pair — mint a one-time device-pairing code (#2251, epic #2242).
 *
 * The admin-only half of the native-API device-pairing flow. A signed-in admin
 * opens the "Connect Device" settings page, which POSTs here; the response is a
 * short-lived 6-char pairing code (+ a QR-encodable redeem URL). The admin's
 * phone/companion app then redeems that code at the PUBLIC `POST /napi/pair/redeem`
 * to receive a read-scoped `sb_` token. This endpoint itself mints NO token —
 * only a code — so even a compromised admin session here can't directly hand
 * out a broader credential than the redeem path allows.
 *
 * TRUST MODEL — identical to `POST /api/auth/token-from-authelia-session`
 * (#2246/#2249). Read that route before touching the header check:
 *   - Authority comes ONLY from NPM's forward-auth `Remote-User` /
 *     `Remote-Groups` headers, which NPM OVERWRITES from the Authelia
 *     auth-request subrequest (`proxy_set_header Remote-User $user;`). A request
 *     that actually carries them has been through Authelia; one without them
 *     (direct/loopback) is untrusted → 401, no code.
 *   - PRIVILEGE-ESCALATION GUARD (#2249, do NOT reintroduce the spoof bug): we
 *     REFUSE any request presenting a client `Authorization: Bearer` token
 *     (403). On a direct `:5888` call a Bearer holder could set its OWN
 *     `Remote-User`/`Remote-Groups` (nothing upstream overwrote them) and
 *     self-mint a code = self-elevation. A token client must never mint identity
 *     here; the legitimate caller is a browser Authelia session (cookie, no
 *     Bearer). We do NOT fall back to a session cookie or a LAN-IP heuristic.
 *   - The identified user must be in the `admins` group.
 *
 * `skipAuth: true`: the Authelia proxy headers ARE the credential (mirrors
 * token-from-authelia-session). No cookie/admin session is separately required.
 */

/** The group an Authelia-identified user must be in to mint a pairing code.
 *  Matches token-from-authelia-session's `admins`. */
const ADMIN_GROUP = 'admins';

function parseGroups(raw: string | null): string[] {
  return (raw || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

/** Derive the browser-facing origin from the proxy-forwarded headers so the QR
 *  encodes a URL the phone can actually open. Behind NPM the Host header is the
 *  public admin hostname and X-Forwarded-Proto is https. Falls back to the
 *  request's own origin. */
function requestOrigin(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') || request.nextUrl.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (host) return `${proto}://${host}`;
  return request.nextUrl.origin;
}

export const POST = withApiHandler({ skipAuth: true }, async ({ request }: { request: NextRequest }) => {
  // PRIVILEGE-ESCALATION GUARD (#2249): refuse any caller presenting a client
  // Bearer. A token must never mint pairing-code authority — see TRUST MODEL.
  const authz = request.headers.get('authorization');
  if (authz && authz.startsWith('Bearer ')) {
    logger.warn(
      'napi:pair',
      'Refused pairing-code mint: request carried a client Bearer token (not a browser Authelia session)',
    );
    return NextResponse.json(
      { error: 'This endpoint is for a browser Authelia session; a token client may not mint a pairing code here' },
      { status: 403 },
    );
  }

  // Only the proxy-injected forward-auth identity is trusted.
  const user = request.headers.get('remote-user');
  if (!user) {
    return NextResponse.json(
      { error: 'Authelia forward-auth identity required (no Remote-User header)' },
      { status: 401 },
    );
  }

  const groups = parseGroups(request.headers.get('remote-groups'));
  if (!groups.includes(ADMIN_GROUP)) {
    logger.warn('napi:pair', `Denied pairing-code mint for "${user}": not in "${ADMIN_GROUP}" (groups=[${groups.join(',')}])`);
    return NextResponse.json(
      { error: `User is not in the "${ADMIN_GROUP}" group` },
      { status: 403 },
    );
  }

  const { code, expiresAt } = createPairingCode(`authelia:${user}`);
  const origin = requestOrigin(request);
  // The QR/deep-link the companion app opens. It carries the code as a query
  // param; the app POSTs it to /napi/pair/redeem (public) to get its token.
  const qrUrl = `${origin}/napi/pair/redeem?code=${encodeURIComponent(code)}`;

  logger.info('napi:pair', `Minted pairing code for admin "${user}" (expires ${new Date(expiresAt).toISOString()})`);

  return NextResponse.json({
    code,
    qr_url: qrUrl,
    expires_at: new Date(expiresAt).toISOString(),
  });
});
