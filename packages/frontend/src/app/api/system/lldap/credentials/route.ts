import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, saveConfig, updateConfig } from '@/lib/config';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/** LLDAP admin credentials (#603 — migrated to withApiHandler). */
export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const lldap = config.lldap;
  return NextResponse.json({
    configured: Boolean(lldap?.password),
    url: lldap?.url ?? '',
    username: lldap?.username ?? '',
  });
});

const PostBody = z.object({
  url: z.string().min(1),
  username: z.string().min(1).optional(),
  password: z.string().min(1),
});

export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
  await updateConfig({
    lldap: { url: body.url, username: body.username || 'admin', password: body.password },
  });
  return NextResponse.json({ ok: true });
});

export const DELETE = withApiHandler({}, async () => {
  const config = await getConfig();
  const next = { ...config };
  delete next.lldap;
  await saveConfig(next);
  return NextResponse.json({ ok: true });
});
