import { NextResponse } from 'next/server';
import { getConfig, updateConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * Read whether NPM admin credentials are stored. Never returns the password
 * itself — only `configured: boolean` and the email if set.
 */
export async function GET() {
  const config = await getConfig();
  const npm = config.reverseProxy?.npm;
  return NextResponse.json({
    configured: Boolean(npm?.email && npm?.password),
    email: npm?.email ?? '',
  });
}

/**
 * Save NPM admin credentials, optionally testing them against a given admin
 * URL first. Body: `{ email, password, adminUrl?, test? }`. When `test` is
 * true and `adminUrl` is provided, the endpoint hits NPM `/api/tokens` first
 * and only persists the credentials if NPM accepted them.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { email, password, adminUrl, test } = body as {
      email?: string;
      password?: string;
      adminUrl?: string;
      test?: boolean;
    };

    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
      return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
    }

    if (test && adminUrl) {
      try {
        const url = new URL(adminUrl);
        const res = await fetch(`${url.origin}/api/tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: email, secret: password }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          return NextResponse.json({ error: `NPM rejected the credentials (HTTP ${res.status})` }, { status: 401 });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'connection failed';
        return NextResponse.json({ error: `Could not reach NPM at ${adminUrl}: ${msg}` }, { status: 502 });
      }
    }

    const config = await getConfig();
    await updateConfig({
      reverseProxy: { ...config.reverseProxy, npm: { email, password } },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to save credentials';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Forget stored NPM credentials.
 */
export async function DELETE() {
  const config = await getConfig();
  const next = { ...config.reverseProxy };
  delete next.npm;
  await updateConfig({ reverseProxy: next });
  return NextResponse.json({ ok: true });
}
