import { NextResponse } from 'next/server';

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
export async function POST(request: Request) {
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
    const message = error instanceof Error ? error.message : 'init failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function initAudiobookshelf(host: string, port: number, username: string, password: string) {
  const url = `http://${host}:${port}/init`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newRoot: { username, password } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return NextResponse.json({ ok: true });
  // 400/409 with "already" in the body means admin already exists — that's
  // a normal state on a re-install over an existing data dir, not a failure.
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
