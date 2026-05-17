import { NextResponse } from 'next/server';
import { getConfig, updateConfig } from '@/lib/config';
import { apiError } from '@/lib/api/errors';

import { requireSession } from '@/lib/api/requireSession';
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
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

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
    return apiError(error, { tag: 'api:system:nginx:credentials:post', status: 500 });
  }
}

/**
 * Forget stored NPM credentials.
 */
export async function DELETE(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  const config = await getConfig();
  const next = { ...config.reverseProxy };
  delete next.npm;
  await updateConfig({ reverseProxy: next });
  return NextResponse.json({ ok: true });
}
