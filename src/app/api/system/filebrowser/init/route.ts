import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { requireSession } from '@/lib/api/requireSession';
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
  // Other fields are returned but only id + username + perm matter for us.
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
 * **Why HTTP API, not `filebrowser users` CLI**: FileBrowser stores
 * users in a BoltDB database (`/database/filebrowser.db`). BoltDB
 * supports only one writer with an exclusive flock — and the
 * running filebrowser server holds that lock for its entire lifetime.
 * Any `podman exec <ct> filebrowser users add/update ...` blocks
 * trying to acquire the lock and hits FB's internal timeout. The
 * fix is to go through FileBrowser's own HTTP API for user
 * management, which doesn't fight itself for the DB.
 *
 * **Why we can spoof `Remote-User: admin`**: the file-share container
 * is configured for proxy-auth (auth.method=proxy, header=Remote-User
 * in .filebrowser.json). FileBrowser trusts whatever Remote-User
 * header it sees. Externally, NPM + Authelia inject that header for
 * SSO-authenticated visitors. Internally, on the host where ServiceBay
 * + filebrowser share a network namespace, we can set it ourselves.
 * The endpoint is gated by requireSession (admin cookie or internal
 * token) on the ServiceBay side, and FileBrowser only listens on
 * 127.0.0.1 — both guards together mean spoofing the header is not
 * an exposure on top of the trust the operator already extended.
 *
 * Idempotent. Re-runs over an existing database either create or
 * update the user to ensure admin perms.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json() as InitRequest;
    const username = (body.username || 'admin').trim();
    if (!/^[a-z][a-z0-9_-]{1,31}$/.test(username)) {
      return NextResponse.json({ error: 'invalid username' }, { status: 400 });
    }

    // Walk the existing users to either create or PATCH the right one.
    const listResp = await fetch(`${FB_BASE}/api/users`, {
      headers: { 'X-Auth': '', 'Remote-User': 'admin' },
    });
    if (!listResp.ok) {
      // FileBrowser may not have finished booting yet — let the
      // post-deploy script's outer retry loop handle that.
      return NextResponse.json({
        error: `FileBrowser API not ready: HTTP ${listResp.status}`,
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
      // Promote to admin. FileBrowser's PUT /api/users/:id expects
      // `which` to list the fields being changed and `data` to
      // contain the full updated user. We patch only perm.
      const merged = { ...existing, perm: { ...existing.perm, ...adminPerm } };
      const putResp = await fetch(`${FB_BASE}/api/users/${existing.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Remote-User': 'admin' },
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
      headers: { 'Content-Type': 'application/json', 'Remote-User': 'admin' },
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
}
