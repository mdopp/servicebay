import { NextResponse, NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * GET /api/auth/me — current-user introspection from forward-auth headers.
 *
 * #1001. NPM's forward-auth snippet (#999) lays down `Remote-User`,
 * `Remote-Name`, `Remote-Email`, `Remote-Groups` on every request to a
 * gated service domain. We just read them back here so the sidebar +
 * portal can render the user chip + Logout without round-tripping to
 * auth.<domain>.
 *
 * When the request doesn't carry the headers (LAN-direct access,
 * dev mode, mock mode), returns `{ authenticated: false }`. Callers
 * render "Not signed in" + a Login link.
 *
 * Groups is a comma-separated list of group names (Authelia's
 * `proxy_set_header Remote-Groups $groups;` joins with `,`). Split
 * to an array for cleaner consumption.
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
  };
}

export const GET = withApiHandler({}, async ({ request }) => {
  const user = readUserFromHeaders(request);
  if (user) return NextResponse.json(user);
  return NextResponse.json({ authenticated: false });
});
