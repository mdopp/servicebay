import { NextResponse } from 'next/server';
import { logout } from '@/lib/auth';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/logout — clear the ServiceBay session cookie.
 *
 * skipAuth: clearing the cookie must work even when the session is already
 * invalid (e.g. after an AUTH_SECRET rotation leaves a stale cookie the user
 * can't otherwise drop). Logging out is harmless and idempotent, so it doesn't
 * need a valid session to proceed. The Authelia-gated path uses auth.<domain>/
 * logout instead; this is for LAN-direct ServiceBay sessions.
 */
export const POST = withApiHandler({ skipAuth: true }, async () => {
  await logout();
  return NextResponse.json({ success: true });
});
