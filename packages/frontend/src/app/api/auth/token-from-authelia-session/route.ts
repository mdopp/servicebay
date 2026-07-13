import { NextRequest, NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { createToken } from '@/lib/auth/apiTokens';
import type { ApiScope } from '@/lib/auth/apiScope';
import { logger } from '@/lib/logger';

/**
 * Authelia-session → scoped SB-MCP token exchange (#2246, option 1).
 *
 * A verified admin's *live* Authelia session mints a short-lived, narrowly
 * scoped SB-MCP Bearer token — WITHOUT any consumer (e.g. the Solaris pod)
 * holding a standing token-minting credential. Authority flows from the
 * human's session: the caller must arrive through the Authelia forward-auth
 * chain (NPM injects `Remote-User` / `Remote-Groups` after auth-request), and
 * the identified user must be in the `admins` group. The minted token carries
 * `read + lifecycle + mutate` — enough for the admin "Wartung" chat's SB tools
 * — and expires in ≤ 1h. It deliberately does NOT grant `destroy` / `exec` /
 * `reboot`: those tiers still go through the per-tool approval flow
 * (#2234/#2237/#2239) on the /mcp path, so a leaked short-token can't wipe or
 * shell the box.
 *
 * TRUST MODEL — read before touching the header check:
 *   The `Remote-User` / `Remote-Groups` headers are trustworthy ONLY because
 *   NPM's forward-auth snippet (`stackInstall/forwardAuth.ts`) sets them via
 *   `proxy_set_header Remote-User $user;` from the Authelia auth-request
 *   subrequest, OVERWRITING any client-supplied copy. So a request that
 *   actually carries these headers has been through Authelia. A request WITHOUT
 *   them (direct/loopback, or a public host not fronted by the forward-auth
 *   chain) is NOT trusted — missing headers → 401, never a token. We never
 *   fall back to a session cookie or a LAN-IP heuristic here: for a token-mint
 *   privilege boundary, the only accepted proof of a verified admin is the
 *   proxy-injected identity.
 *
 * `skipAuth: true`: the Authelia proxy headers ARE the credential (mirrors
 * `/api/auth/session-from-token`, which treats the presented Bearer as the
 * credential). No cookie/admin session is required — that's the point.
 */

/** The group an Authelia-identified user must be in to mint a token here.
 *  Matches the platform's `admins` LLDAP group (the same group NPM's
 *  admin-only subdomains gate on — see reverseProxy/lanDeniedPage.ts). */
const ADMIN_GROUP = 'admins';

/** Scopes the minted token carries. Deliberately excludes destroy/exec/reboot
 *  — those stay behind the per-tool approval flow on /mcp (#2234). */
const MINTED_SCOPES: ApiScope[] = ['read', 'lifecycle', 'mutate'];

/** Hard TTL cap for the minted token: ≤ 1h (#2246). */
const TOKEN_TTL_MS = 60 * 60 * 1000;

function parseGroups(raw: string | null): string[] {
  return (raw || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

export const POST = withApiHandler({ skipAuth: true }, async ({ request }: { request: NextRequest }) => {
  // Only the proxy-injected identity is trusted (see TRUST MODEL above).
  const user = request.headers.get('remote-user');
  if (!user) {
    // No forward-auth identity → the request did not come through Authelia.
    // Never mint a token for a header-less (direct/loopback) caller.
    return NextResponse.json(
      { error: 'Authelia forward-auth identity required (no Remote-User header)' },
      { status: 401 },
    );
  }

  const groups = parseGroups(request.headers.get('remote-groups'));
  if (!groups.includes(ADMIN_GROUP)) {
    logger.warn(
      'api:auth:token-from-authelia-session',
      `Denied token exchange for "${user}": not in "${ADMIN_GROUP}" (groups=[${groups.join(',')}])`,
    );
    return NextResponse.json(
      { error: `User is not in the "${ADMIN_GROUP}" group` },
      { status: 403 },
    );
  }

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const { token, secret } = await createToken({
    name: `authelia-session:${user}`.slice(0, 100),
    scopes: MINTED_SCOPES,
    expiresAt,
    createdBy: `authelia:${user}`,
  });

  logger.info(
    'api:auth:token-from-authelia-session',
    `Minted scoped MCP token ${token.id} for admin "${user}" scopes=[${token.scopes.join(',')}] expires=${expiresAt}`,
  );

  return NextResponse.json({
    token: secret,
    scopes: token.scopes,
    expiresAt,
  });
});
