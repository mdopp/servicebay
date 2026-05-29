import { NextResponse } from 'next/server';
import { getSessionFromCookieHeader, type SessionPayload } from '@/lib/auth/session';
import { getInternalApiToken } from '@/lib/auth/internalToken';
import type { ApiScope } from '@/lib/auth/apiScope';

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
 *   3. A valid session cookie (all scopes, for back-compat).
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
    const authz = request.headers.get('authorization');
    const bearer = authz?.startsWith('Bearer ') ? authz.slice(7).trim() : undefined;
    if (bearer) {
      const { verifyToken } = await import('@/lib/auth/apiTokens');
      const token = await verifyToken(bearer);
      if (token && token.scopes.includes(options.tokenScope)) {
        return {
          user: `token:${token.name}`,
          expires: new Date(Date.now() + 60_000),
          scopes: token.scopes,
        };
      }
      // A presented-but-rejected Bearer (bad/expired/insufficient-scope)
      // must not silently fall through to the cookie check.
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
  }

  const session = await getSessionFromCookieHeader(request.headers.get('cookie') ?? undefined);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  return session;
}
