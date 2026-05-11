import { NextResponse } from 'next/server';
import { getConfig, saveConfig, updateConfig } from '@/lib/config';
import { apiError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Read whether AdGuard admin credentials are stored. Never returns the
 * password itself — only `configured: boolean`, the admin URL, and the
 * username. Mirrors the LLDAP/NPM credentials pattern.
 */
export async function GET() {
  const config = await getConfig();
  const adguard = config.adguard;
  return NextResponse.json({
    configured: Boolean(adguard?.password),
    adminUrl: adguard?.adminUrl ?? '',
    username: adguard?.username ?? '',
  });
}

/**
 * Save AdGuard admin credentials. Body: `{ adminUrl, username, password }`.
 * Called by the AdGuard post-deploy after a successful login probe so
 * ServiceBay can manage DNS rewrites + run the FritzBox-DNS hand-off
 * without ever prompting the operator again.
 *
 * Side effect: triggers `provisionPortalRouting()` in the background.
 * That's the moment AdGuard's admin password becomes available, so
 * the wildcard rewrites (`*.<lanDomain>`, `*.<publicDomain>` for
 * split-horizon) get a chance to land. The provisioner is idempotent
 * — if it fires here and again at server-boot, the second call is a
 * no-op.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { adminUrl, username, password } = body as {
      adminUrl?: string;
      username?: string;
      password?: string;
    };

    if (typeof adminUrl !== 'string' || !adminUrl || typeof password !== 'string' || !password) {
      return NextResponse.json({ error: 'adminUrl and password are required' }, { status: 400 });
    }

    await updateConfig({
      adguard: { adminUrl, username: username || 'admin', password },
    });

    // Fire-and-forget: with creds now stored, retry the portal/rewrite
    // provisioner. AdGuard's post-deploy runs after the container is
    // healthy, so AdGuard is reachable here. The provisioner is
    // best-effort and logs its own failures; we don't block the
    // credential save on it.
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
  } catch (error) {
    return apiError(error, { tag: 'api:system:adguard:credentials:post', status: 500 });
  }
}

/**
 * Forget stored AdGuard credentials. Uses saveConfig directly because
 * updateConfig deep-merges and cannot delete keys.
 */
export async function DELETE() {
  const config = await getConfig();
  const next = { ...config };
  delete next.adguard;
  await saveConfig(next);
  return NextResponse.json({ ok: true });
}
