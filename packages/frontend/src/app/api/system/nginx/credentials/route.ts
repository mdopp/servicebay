import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** NPM admin credentials (#603 — migrated to withApiHandler). */
export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const npm = config.reverseProxy?.npm;
  return NextResponse.json({
    configured: Boolean(npm?.email && npm?.password),
    email: npm?.email ?? '',
  });
});

const PostBody = z.object({
  email: z.string().min(1),
  password: z.string().min(1),
  adminUrl: z.string().min(1).optional(),
  test: z.boolean().optional(),
});

/**
 * Save NPM admin credentials. When `test` is true and `adminUrl` is
 * provided, hits NPM `/api/tokens` first and only persists on success.
 */
export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
  const { email, password, adminUrl, test } = body;
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
});

export const DELETE = withApiHandler({}, async () => {
  const config = await getConfig();
  const next = { ...config.reverseProxy };
  delete next.npm;
  await updateConfig({ reverseProxy: next });
  return NextResponse.json({ ok: true });
});
