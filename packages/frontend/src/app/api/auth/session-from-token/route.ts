import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { verifyToken } from '@/lib/auth/apiTokens';
import { encryptSession } from '@/lib/auth/session';
import { isRequestSecure } from '@/lib/auth/requestSecurity';
import { logger } from '@/lib/logger';

/**
 * Token → session bridge (epic #2047, the chain-of-trust use case).
 *
 * The named-API-token system authenticates the *API* (Bearer → scoped
 * endpoints), but the rendered UI authenticates by **session cookie** — a page
 * checks `/api/auth/me`, finds no session for a Bearer caller, and bounces to
 * `/login`. So a token alone cannot drive the browser. This endpoint closes
 * that gap WITHOUT handing out the admin password: it exchanges a valid Bearer
 * token for a **scoped, short-lived session cookie** that mirrors the token's
 * scopes and never outlives it.
 *
 * Safety:
 *  - The session carries `scopes = token.scopes`, so a `read`-only token yields
 *    a read-only session — it can render the UI but mutating endpoints (which
 *    demand a higher scope) still reject it.
 *  - The session carries `viaToken = token.id`; `requireSession` re-checks the
 *    token is still live on every request, so **revoking the token instantly
 *    kills the session** (cascading revocation, #2047).
 *  - The cookie expiry is `min(token.expiresAt, now + 1h)` — it never outlives
 *    the token and is capped regardless.
 *
 * `skipAuth: true`: the presented Bearer token IS the credential (mirrors
 * `/api/system/api-tokens/delegate`). No cookie/admin session is required —
 * that's the whole point.
 */
const MAX_SESSION_TTL_MS = 60 * 60 * 1000; // 1h hard cap

export const POST = withApiHandler({ skipAuth: true }, async ({ request }) => {
  const authz = request.headers.get('authorization') ?? '';
  const raw = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!raw) {
    return NextResponse.json({ error: 'Bearer token required' }, { status: 401 });
  }

  const token = await verifyToken(raw);
  if (!token) {
    return NextResponse.json({ error: 'Invalid, expired, or revoked token' }, { status: 401 });
  }

  // Session never outlives the token, and is capped at 1h regardless.
  const cap = Date.now() + MAX_SESSION_TTL_MS;
  const tokenExp = token.expiresAt ? Date.parse(token.expiresAt) : Infinity;
  const expires = new Date(Math.min(cap, tokenExp));

  const session = await encryptSession({
    user: `token:${token.name}`,
    expires,
    scopes: token.scopes,
    viaToken: token.id,
  });

  logger.info(
    'api:auth:session-from-token',
    `Issued scoped session from token ${token.id} ("${token.name}") scopes=[${token.scopes.join(',')}] expires=${expires.toISOString()}`,
  );

  const res = NextResponse.json({
    ok: true,
    user: `token:${token.name}`,
    scopes: token.scopes,
    expires: expires.toISOString(),
  });
  res.cookies.set('session', session, {
    expires,
    httpOnly: true,
    sameSite: 'lax',
    // Per-request like the login route: a Secure cookie over plain-HTTP LAN
    // would be refused by the browser.
    secure: isRequestSecure(request),
    path: '/',
  });
  return res;
});
