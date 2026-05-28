import { NextResponse, NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { getSessionFromCookieHeader } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/me — current-user introspection.
 *
 * #1001. When ServiceBay is reached through the Authelia forward-auth chain,
 * NPM's snippet (#999) lays down `Remote-User`/`Remote-Name`/`Remote-Email`/
 * `Remote-Groups`; we read those back so the sidebar + portal can render the
 * user chip + Logout without round-tripping to auth.<domain>.
 *
 * On LAN-direct access those headers don't exist — but the operator still has
 * a ServiceBay *session* (the cookie set by /api/auth/login). Fall back to it
 * so the sidebar shows who's signed in and offers a Logout that clears the
 * ServiceBay session. `source` tells the client which logout path to use.
 *
 * Returns `{ authenticated: false }` only when neither is present.
 *
 * Groups is a comma-separated list (Authelia's `Remote-Groups` joins with
 * `,`). Split to an array for cleaner consumption.
 */
function readUserFromHeaders(req: NextRequest) {
  const username = req.headers.get('remote-user');
  if (!username) return null;
  const groupsRaw = req.headers.get('remote-groups') || '';
  return {
    authenticated: true as const,
    username,
    displayName: req.headers.get('remote-name') || username,
    email: req.headers.get('remote-email') || '',
    groups: groupsRaw.split(',').map(g => g.trim()).filter(Boolean),
    source: 'forward-auth' as const,
  };
}

export const GET = withApiHandler({}, async ({ request }) => {
  const fromHeaders = readUserFromHeaders(request);
  if (fromHeaders) return NextResponse.json(fromHeaders);

  const session = await getSessionFromCookieHeader(request.headers.get('cookie') ?? undefined);
  if (session) {
    return NextResponse.json({
      authenticated: true,
      username: session.user,
      displayName: session.user,
      email: '',
      groups: [],
      source: 'session',
    });
  }

  return NextResponse.json({ authenticated: false });
});
