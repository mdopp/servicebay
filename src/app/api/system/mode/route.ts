import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, updateConfig } from '@/lib/config';
import { getMode, getActiveDomain, isLocalOnly } from '@/lib/mode';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/mode — install-mode classification for the
 * dashboard header badge. Cheap, no agent calls.
 *
 * POST — set or clear `reverseProxy.publicDomain`. Migrated to
 * withApiHandler in #603.
 */
export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  return NextResponse.json({
    mode: getMode(config),
    activeDomain: getActiveDomain(config),
    publicDomain: config.reverseProxy?.publicDomain ?? null,
    lanDomain: config.reverseProxy?.lanDomain ?? null,
    localOnly: isLocalOnly(config),
  });
});

const PostBody = z.object({
  publicDomain: z.string().nullable().optional(),
});

export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
  const next = typeof body.publicDomain === 'string' ? body.publicDomain.trim() : '';
  if (next && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(next)) {
    return NextResponse.json({ error: 'Domain must be a valid hostname (e.g. example.com).' }, { status: 400 });
  }
  const config = await getConfig();
  await updateConfig({
    reverseProxy: { ...config.reverseProxy, publicDomain: next || undefined },
  });
  return NextResponse.json({ ok: true, mode: next ? 'public' : 'lan' });
});
