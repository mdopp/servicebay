import { NextResponse } from 'next/server';
import { getSessionFromCookieHeader, type SessionPayload } from '@/lib/auth/session';

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
 * This is intentionally a per-handler helper rather than a global
 * middleware: the broader hardening plan (PR1) layers a `middleware.ts`
 * gate on top of this. Until that lands, the helper at least closes the
 * destructive routes one by one.
 */
export async function requireSession(
  request: Request,
): Promise<SessionPayload | NextResponse> {
  const session = await getSessionFromCookieHeader(request.headers.get('cookie') ?? undefined);
  if (!session) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }
  return session;
}
