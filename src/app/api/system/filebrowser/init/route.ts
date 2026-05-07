import { NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { DigitalTwinStore } from '@/lib/store/twin';
import { requireSession } from '@/lib/api/requireSession';

export const dynamic = 'force-dynamic';

interface InitRequest {
  /** LLDAP username that should land as FileBrowser admin. */
  username?: string;
  /** Target node, defaults to first known node. */
  node?: string;
}

const CONTAINER_NAME = 'filebrowser-filebrowser';
const DB_PATH = '/database/filebrowser.db';

/**
 * POST /api/system/filebrowser/init
 *
 * In proxy-auth mode FileBrowser auto-creates a user record on the first
 * SSO request, but it inherits the default permissions (admin: false).
 * The result is a chicken-and-egg: nobody can promote anyone else to
 * admin because there's no admin yet. This endpoint runs once at install
 * time and either creates the user with admin perms or upgrades an
 * existing record.
 *
 * Idempotent: subsequent calls are no-ops because `users add` fails when
 * the user already exists, and we then fall back to `users update`.
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

    const twin = DigitalTwinStore.getInstance();
    const nodeName = body.node || Object.keys(twin.nodes)[0];
    if (!nodeName) {
      return NextResponse.json({ error: 'No nodes available' }, { status: 404 });
    }

    const agent = await agentManager.ensureAgent(nodeName);

    // FileBrowser stores user records in a SQLite DB. The CLI is the
    // documented way to manage them. The password we pass is irrelevant
    // — proxy-auth mode never validates it, the user is identified by
    // the Remote-User header alone.
    const dummyPassword = 'sso-managed-' + Math.random().toString(36).slice(2);

    // Try create first. If the user already exists (re-install over the
    // same database volume), fall back to update.
    const addRes = await agent.sendCommand('exec', {
      command: `podman exec ${CONTAINER_NAME} filebrowser users add ${username} ${dummyPassword} --perm.admin --database ${DB_PATH}`,
    });

    if (addRes.code !== 0) {
      // Probably already exists — try to upgrade their perms.
      const updateRes = await agent.sendCommand('exec', {
        command: `podman exec ${CONTAINER_NAME} filebrowser users update ${username} --perm.admin --database ${DB_PATH}`,
      });
      if (updateRes.code !== 0) {
        return NextResponse.json({
          error: `Could not seed FileBrowser admin: ${updateRes.stderr || updateRes.stdout || 'unknown'}`,
        }, { status: 502 });
      }
      return NextResponse.json({ ok: true, action: 'updated', username });
    }

    return NextResponse.json({ ok: true, action: 'created', username });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'init failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
