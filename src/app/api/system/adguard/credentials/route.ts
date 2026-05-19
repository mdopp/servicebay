import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConfig, saveConfig, updateConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * AdGuard admin credentials endpoint. Mirrors the LLDAP/NPM
 * credentials shape. Migrated to withApiHandler in #603.
 */
export const GET = withApiHandler({}, async () => {
  const config = await getConfig();
  const adguard = config.adguard;
  return NextResponse.json({
    configured: Boolean(adguard?.password),
    adminUrl: adguard?.adminUrl ?? '',
    username: adguard?.username ?? '',
  });
});

const PostBody = z.object({
  adminUrl: z.string().min(1),
  username: z.string().min(1).optional(),
  password: z.string().min(1),
});

/**
 * Save AdGuard admin credentials + trigger portal-routing provisioner
 * in the background. Provisioner is idempotent (#536/#549).
 */
export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
  await updateConfig({
    adguard: { adminUrl: body.adminUrl, username: body.username || 'admin', password: body.password },
  });
  void (async () => {
    try {
      const { provisionPortalRouting } = await import('@/lib/portal/provisioner');
      const result = await provisionPortalRouting();
      logger.info('api:system:adguard:credentials', `Triggered portal+rewrite provisioner: ${result.detail}`);
    } catch (e) {
      logger.warn('api:system:adguard:credentials', `Provisioner retry after AdGuard creds save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  return NextResponse.json({ ok: true });
});

/**
 * Forget stored AdGuard credentials. saveConfig (not updateConfig)
 * because deep-merge can't delete keys.
 */
export const DELETE = withApiHandler({}, async () => {
  const config = await getConfig();
  const next = { ...config };
  delete next.adguard;
  await saveConfig(next);
  return NextResponse.json({ ok: true });
});
