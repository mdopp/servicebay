import { NextResponse } from 'next/server';
import { getSessionFromCookieHeader, type SessionPayload } from '@/lib/auth/session';
import { getInternalApiToken } from '@/lib/auth/internalToken';
import { scopeSatisfiedBy, type ApiScope } from '@/lib/auth/apiScope';
import { gateForTokenPrincipal } from '@/lib/api/tokenPrincipalRoutes';

export interface RequireSessionOptions {
  /**
   * If set, a named API token (`Authorization: Bearer sb_…`) is accepted on
   * this route **only** when the token carries this scope. Routes that omit
   * `tokenScope` reject Bearer tokens entirely and stay cookie/internal-only
   * — see #1264. This is a deliberate per-route opt-in: REST routes don't
   * carry a scope map the way MCP tools do, so blanket Bearer acceptance
   * would let a narrowly-scoped token reach every route.
   */
  tokenScope?: ApiScope;
  /**
   * Hold a *scoped cookie session* to this scope **without** opening the Bearer
   * branch (#2919).
   *
   * `tokenScope` does two things at once: it applies `tokenPrincipalRefusal` to a
   * bridged cookie session AND it makes the route reachable with a raw
   * `Authorization: Bearer sb_…`. On a credential-**minting** route the second
   * half is a hole of its own — a short-lived token could mint an unparented,
   * arbitrarily long-lived one, escaping both the TTL narrowing and the
   * cascading revocation the delegation chain gives it (#2047/#2048). So the
   * mint routes take the first half alone: still cookie/internal-only, but a
   * session bridged from a token is held to that token's scopes.
   */
  cookieScope?: ApiScope;
}

/**
 * Gate an API route on a valid ServiceBay session cookie.
 *
 * Returns the decoded session on success, or a `NextResponse` 401 that the
 * caller should return as-is. Pattern at the top of any sensitive handler:
 *
 *     const auth = await requireSession(request);
 *     if (auth instanceof NextResponse) return auth;
 *     // …auth is the session payload from here on…
 *
 * Accepted credentials, in order:
 *   1. `X-SB-Internal-Token` server-to-server header — the same one
 *      `proxy.ts` honors at the middleware layer. Without this, post-deploy
 *      scripts that legitimately reach internal admin endpoints (e.g.
 *      file-share's filebrowser/init seed) get 401'd at the route handler
 *      even though middleware lets them through. Returns a synthetic payload
 *      tagged `user: 'internal'` with all scopes.
 *   2. `Authorization: Bearer sb_…` named API token — only when the caller
 *      opts in via `options.tokenScope` AND the token holds that scope
 *      (#1264). Returns `user: 'token:<name>'` carrying the token's scopes.
 *   3. A valid session cookie. A cookie minted by the token→session bridge
 *      (`POST /api/auth/session-from-token`) carries the source token's
 *      `scopes`, and is held to them exactly like the Bearer branch (#2768) —
 *      on a `tokenScope`/`cookieScope` route by the route's own declaration,
 *      and on a route that declares neither by the written classification in
 *      `tokenPrincipalRoutes.ts`, which defaults to refusing (#2958). A cookie
 *      without `scopes` (password login) means all scopes, for back-compat and
 *      is untouched by any of it.
 *
 * This is intentionally a per-handler helper rather than a global
 * middleware: the broader hardening plan (PR1) layers a `middleware.ts`
 * gate on top of this. Until that lands, the helper at least closes the
 * destructive routes one by one.
 */
export async function requireSession(
  request: Request,
  options: RequireSessionOptions = {},
): Promise<SessionPayload | NextResponse> {
  const presented = request.headers.get('x-sb-internal-token');
  if (presented) {
    const expected = getInternalApiToken();
    if (presented.length === expected.length) {
      // Constant-time compare via Buffer to avoid timing leaks —
      // mirrors proxy.ts's check.
      const a = Buffer.from(presented);
      const b = Buffer.from(expected);
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      if (diff === 0) {
        return { user: 'internal', expires: new Date(Date.now() + 60_000) };
      }
    }
  }

  // Named API token — only honored on routes that opt in with a scope.
  if (options.tokenScope) {
    const settled = await bearerOutcome(request, options.tokenScope);
    if (settled) return settled;
  }

  const session = await getSessionFromCookieHeader(request.headers.get('cookie') ?? undefined);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  // Token-bridged sessions (minted via /api/auth/session-from-token) live only
  // as long as their source token: re-check it on every request so revoking or
  // expiring the token instantly kills the session (#2047 cascading revocation,
  // extended to the UI session). Password/internal sessions have no viaToken
  // and skip this entirely.
  //
  // #2931 moved this rule down into `getSessionFromCookieHeader` so that /mcp,
  // Socket.IO and the proxy gate get it too — this repeat is belt-and-braces
  // for a caller that hands `requireSession` a session from somewhere else, and
  // costs nothing on the (overwhelmingly common) viaToken-less session.
  if (session.viaToken) {
    const { tokenIsLive } = await import('@/lib/auth/apiTokens');
    if (!(await tokenIsLive(session.viaToken))) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
  }
  // `cookieScope` is the same refusal without the Bearer opt-in (#2919); a route
  // that declares neither is classified in `tokenPrincipalRoutes.ts` (#2958).
  return tokenPrincipalRefusal(request, session, options.tokenScope ?? options.cookieScope)
    ?? session;
}

/**
 * Settle a presented Bearer, or return `null` when there is none to settle.
 *
 * A presented-but-rejected Bearer must never fall through to the cookie check
 * — that is what makes opting a route into token auth safe. But the reasons it
 * was rejected are not one answer (#3001):
 *
 *  - The token VERIFIED and merely lacks the tier → it is **authenticated and
 *    under-scoped**, so it gets a 403 that NAMES the tier, exactly as
 *    `scopeRefusal` has answered on the cookie path since #2958. Before this
 *    split, one question had two answers depending on whether the credential
 *    arrived as a Bearer or as a cookie bridged from that same token.
 *  - The token is unknown, revoked or expired → the flat 401, and it is told
 *    **nothing** about the route. A credential that does not verify has no
 *    claim to learn which tier it would have needed; answering otherwise turns
 *    every revoked token into a scope-map oracle.
 *
 * The distinction is not a detail of wording. An agent refused without a reason
 * has no next step, and on 2026-09-20 one improvised its way through an
 * evening: raw `/mcp`, the token in argv, a `delegate` child left alive, a
 * foreign service redeployed into a crash loop (#2990, #2994, #2995).
 * `servicebay whoami` answers "what may I do", but only once somebody thinks to
 * ask — the refusal is where the answer is actually needed.
 */
async function bearerOutcome(
  request: Request,
  required: ApiScope,
): Promise<SessionPayload | NextResponse | null> {
  const authz = request.headers.get('authorization');
  const bearer = authz?.startsWith('Bearer ') ? authz.slice(7).trim() : undefined;
  if (!bearer) return null;

  const { verifyToken } = await import('@/lib/auth/apiTokens');
  const token = await verifyToken(bearer);
  if (token && token.scopes.includes(required)) {
    return {
      user: `token:${token.name}`,
      expires: new Date(Date.now() + 60_000),
      scopes: token.scopes,
    };
  }
  if (token) {
    return NextResponse.json({ error: `Forbidden: '${required}' scope required` }, { status: 403 });
  }
  return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
}

/**
 * The one place a **token principal** is held to a scope (#2958).
 *
 * A cookie minted by the token→session bridge (`POST /api/auth/session-from-token`)
 * carries `scopes = token.scopes`. Without a check here a `read`-only token could be
 * traded for a cookie and then drive a `tokenScope: 'destroy'` route — the Bearer
 * branch's scope gate, laundered away by a round-trip through the bridge (#2768).
 *
 * Two cases, one rule:
 *  - The route **declares** a scope (`tokenScope`, or `cookieScope` for a route that
 *    must stay cookie-only, #2919) → the session's scopes must satisfy it. Identical
 *    to what the Bearer branch above already enforces.
 *  - The route declares **nothing** → a bearer cannot reach it at all, so the cookie
 *    path consults the written classification in `tokenPrincipalRoutes.ts`. An
 *    unclassified route is refused, so the cookie can never be the stronger of the
 *    two credentials (#2958). This replaced the per-route `cookieScope` patches
 *    #2943 had to add to the container-log routes one at a time.
 *
 * Omitted `scopes` means "all" (password login / internal principal) and returns
 * before any of this — a password session behaves exactly as it did. Returns a 403
 * (authenticated but under-scoped, like `requireAssistAdmin`) or null to proceed.
 *
 * This is deliberately the ONLY scope check on the cookie path. `proxy.ts` decides
 * reachability and knows nothing of a route's declared scope; putting a second copy
 * of this rule there would need a parallel path→scope map, and the two would drift.
 */
function tokenPrincipalRefusal(
  request: Request,
  session: SessionPayload,
  declared: ApiScope | undefined,
): NextResponse | null {
  if (!session.scopes) return null;
  if (declared) return scopeRefusal(session.scopes, declared);

  const gate = gateForTokenPrincipal(request.method, pathnameOf(request));
  if (gate === 'any') return null;
  if (gate === 'deny') {
    return NextResponse.json(
      { error: 'Forbidden: this route is not reachable by an API-token principal' },
      { status: 403 },
    );
  }
  return scopeRefusal(session.scopes, gate);
}

function scopeRefusal(held: readonly ApiScope[], required: ApiScope): NextResponse | null {
  if (scopeSatisfiedBy(held, required)) return null;
  return NextResponse.json(
    { error: `Forbidden: '${required}' scope required` },
    { status: 403 },
  );
}

/** Route path for the classification lookup. An unparseable URL yields a path that
 *  matches no rule, so the lookup falls to its `deny` default — fail closed. */
function pathnameOf(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '';
  }
}
