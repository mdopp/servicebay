import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/errors';

import { withApiHandler } from '@/lib/api/handler';
export const dynamic = 'force-dynamic';

interface InitRequest {
  service: 'audiobookshelf' | 'navidrome';
  host: string;
  port: number;
  username: string;
  password: string;
}

/**
 * POST /api/system/media/init
 *
 * Proxy that calls the first-run setup endpoints of media servers so the
 * install wizard can pre-create their admin users — replicating what the
 * user would otherwise do by hand on first visit. ServiceBay runs in the
 * same network namespace as the target pod (host network) so localhost
 * + the container's port reach it directly.
 *
 * Returns:
 *   { ok: true }                  — admin created
 *   { alreadySetup: true }        — service refused because an admin already
 *                                   exists; not an error, just a signal
 *   { error: '...' }              — anything else
 */
export const POST = withApiHandler({}, async ({ request }) => {
  try {
    const body = await request.json() as Partial<InitRequest>;
    const { service, host, port, username, password } = body;
    if (!service || !host || !port || !username || !password) {
      return NextResponse.json({ error: 'service, host, port, username, password required' }, { status: 400 });
    }

    if (service === 'audiobookshelf') {
      return await initAudiobookshelf(host, port, username, password);
    }
    if (service === 'navidrome') {
      return await initNavidrome(host, port, username, password);
    }
    return NextResponse.json({ error: `unknown service: ${service}` }, { status: 400 });
  } catch (error) {
    return apiError(error, { tag: 'api:system:media:init', status: 500 });
  }
});

async function initAudiobookshelf(host: string, port: number, username: string, password: string) {
  // Probe /status first — `isInit:true` means a root user already exists.
  // ABS 2.x returns generic HTTP 500 with body "Internal Server Error" when
  // /init is hit on an initialised server (the "already has a root user"
  // log line stays inside the container), so the previous body-text match
  // missed and the post-deploy spun for 5 minutes before timing out.
  try {
    const statusRes = await fetch(`http://${host}:${port}/status`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    if (statusRes.ok) {
      const status = await statusRes.json().catch(() => ({} as Record<string, unknown>));
      if (status.isInit === true) return NextResponse.json({ alreadySetup: true });
    }
  } catch {
    // /status itself failed — fall through to /init and let that report the
    // actual error.
  }

  const url = `http://${host}:${port}/init`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newRoot: { username, password } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return NextResponse.json({ ok: true });
  // Body-text fallback for non-2.x or upstream message changes.
  const text = await res.text().catch(() => '');
  if (text.toLowerCase().includes('already') || res.status === 409) {
    return NextResponse.json({ alreadySetup: true });
  }
  return NextResponse.json({ error: `Audiobookshelf rejected /init (HTTP ${res.status}): ${text.slice(0, 200)}` }, { status: 502 });
}

async function initNavidrome(host: string, port: number, username: string, password: string) {
  const url = `http://${host}:${port}/auth/createAdmin`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return NextResponse.json({ ok: true });
  const text = await res.text().catch(() => '');
  if (text.toLowerCase().includes('admin') && (res.status === 400 || res.status === 409)) {
    return NextResponse.json({ alreadySetup: true });
  }
  return NextResponse.json({ error: `Navidrome rejected /auth/createAdmin (HTTP ${res.status}): ${text.slice(0, 200)}` }, { status: 502 });
}
