import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

interface InitRequest {
  /** LLDAP username that should land as FileBrowser admin. */
  username?: string;
}

// FileBrowser binds 127.0.0.1:FB_PORT inside the file-share pod's host
// network namespace. ServiceBay shares the same host network, so
// localhost:8088 from this process reaches FileBrowser directly —
// no agent SSH hop needed.
const FB_BASE = 'http://127.0.0.1:8088';

interface FbUser {
  id: number;
  username: string;
  perm?: Record<string, boolean>;
}

/**
 * POST /api/system/filebrowser/init
 *
 * In proxy-auth mode FileBrowser auto-creates a user record on the
 * first SSO request, but it inherits the default permissions
 * (admin: false). The result is a chicken-and-egg: nobody can promote
 * anyone else to admin because there's no admin yet. This endpoint
 * runs once at install time and either creates the user with admin
 * perms or upgrades an existing record.
 *
 * **Why HTTP API, not the CLI**: FileBrowser's user records live in a
 * BoltDB database with an exclusive flock held by the running server.
 * Any `podman exec <ct> filebrowser users add/update` blocks trying
 * to acquire that lock and hits FB's internal timeout. Driving the
 * change through FileBrowser's own HTTP API sidesteps the contention.
 *
 * **Auth shape**: FileBrowser's API endpoints (`/api/users`,
 * `/api/users/{id}`) use a JWT in the `X-Auth` header — they don't
 * read Remote-User directly. To get that JWT in proxy-auth mode you
 * POST `/api/login` with the Remote-User header set; the auther
 * picks the user out of the header, validates it against the DB,
 * and writes a signed JWT to the response body. That JWT then
 * authorises `/api/users` etc.
 *
 * The trust chain: ServiceBay shares filebrowser's host network and
 * filebrowser binds 127.0.0.1, so this loopback path is only
 * reachable from the same host. The endpoint stays gated by
 * requireSession (admin cookie or internal token), and 'admin'
 * exists in FB's DB because filebrowser auto-creates the first user
 * on startup. Spoofing Remote-User here doesn't widen the existing
 * trust surface.
 */
export const POST = withApiHandler({}, async ({ request }) => {
  try {
    const body = await request.json() as InitRequest;
    const username = (body.username || 'admin').trim();
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(username)) {
      return NextResponse.json({ error: 'invalid username' }, { status: 400 });
    }

    // Step 1: trade Remote-User: admin for a JWT. FileBrowser's
    // proxy-auther reads the header, looks the user up (auto-creates
    // if missing — first-user wins admin), and writes the signed
    // JWT to the response body as plain text.
    const loginResp = await fetch(`${FB_BASE}/api/login`, {
      method: 'POST',
      headers: { 'Remote-User': 'admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!loginResp.ok) {
      return NextResponse.json({
        error: `FileBrowser /api/login as admin returned HTTP ${loginResp.status} — server still warming up?`,
      }, { status: 502 });
    }
    const jwt = (await loginResp.text()).trim();
    if (!jwt || jwt.split('.').length !== 3) {
      return NextResponse.json({
        error: `FileBrowser /api/login returned an unexpected body (${jwt.slice(0, 80)})`,
      }, { status: 502 });
    }

    // Step 2: list users to decide between create vs. promote.
    const listResp = await fetch(`${FB_BASE}/api/users`, {
      headers: { 'X-Auth': jwt },
    });
    if (!listResp.ok) {
      return NextResponse.json({
        error: `FileBrowser GET /api/users returned HTTP ${listResp.status} — admin permissions not yet active?`,
      }, { status: 502 });
    }
    const users = (await listResp.json()) as FbUser[];
    const existing = users.find(u => u.username === username);

    const adminPerm = {
      admin: true,
      create: true,
      delete: true,
      download: true,
      modify: true,
      rename: true,
      share: true,
      execute: false,
    };

    if (existing) {
      const merged = { ...existing, perm: { ...existing.perm, ...adminPerm } };
      const putResp = await fetch(`${FB_BASE}/api/users/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Auth': jwt },
        body: JSON.stringify({ what: 'user', which: ['perm'], data: merged }),
      });
      if (!putResp.ok) {
        const err = await putResp.text().catch(() => '');
        return NextResponse.json({
          error: `Could not promote ${username} to admin: HTTP ${putResp.status} ${err.slice(0, 200)}`,
        }, { status: 502 });
      }
      return NextResponse.json({ ok: true, action: 'promoted', username });
    }

    // No record yet — create one. The password is irrelevant under
    // proxy-auth (FileBrowser never validates it; the operator's
    // password is whatever LLDAP/Authelia checks), but the API
    // requires the field non-empty. Use a random throwaway.
    const dummyPassword = crypto.randomBytes(16).toString('hex');
    const newUser = {
      username,
      password: dummyPassword,
      scope: '.',
      locale: 'en',
      lockPassword: false,
      viewMode: 'list',
      singleClick: false,
      perm: adminPerm,
      commands: [],
      sorting: { by: 'name', asc: true },
    };
    const postResp = await fetch(`${FB_BASE}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth': jwt },
      body: JSON.stringify({ what: 'user', which: ['all'], data: newUser }),
    });
    if (!postResp.ok) {
      const err = await postResp.text().catch(() => '');
      return NextResponse.json({
        error: `Could not create ${username}: HTTP ${postResp.status} ${err.slice(0, 200)}`,
      }, { status: 502 });
    }
    return NextResponse.json({ ok: true, action: 'created', username });
  } catch (error) {
    return apiError(error, { tag: 'api:system:filebrowser:init', status: 500 });
  }
});
