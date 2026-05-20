import { NextResponse } from 'next/server';
import { getSessionFromCookieHeader, type SessionPayload } from '@/lib/auth/session';
import { getInternalApiToken } from '@/lib/auth/internalToken';

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
 * Also accepts the `X-SB-Internal-Token` server-to-server header — the
 * same one `proxy.ts` honors at the middleware layer. Without this,
 * post-deploy scripts that legitimately reach internal admin endpoints
 * (e.g. file-share's filebrowser/init seed) get 401'd at the route
 * handler even though middleware lets them through. Returns a synthetic
 * session payload tagged `user: 'internal'` so callers can distinguish
 * if needed.
 *
 * This is intentionally a per-handler helper rather than a global
 * middleware: the broader hardening plan (PR1) layers a `middleware.ts`
 * gate on top of this. Until that lands, the helper at least closes the
 * destructive routes one by one.
 */
export async function requireSession(
  request: Request,
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
  const session = await getSessionFromCookieHeader(request.headers.get('cookie') ?? undefined);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  return session;
}
