import { NextResponse } from 'next/server';
import { z } from 'zod';
import { checkForUpdates, performUpdate } from '@/lib/updater';
import { getConfig, saveConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * ServiceBay updater + auto-update config (#603 migration).
 *
 * GET returns the current update status (latest version, current
 * version, whether autoUpdate is on) + the full config so the
 * UpdatesSection can render without a second fetch.
 *
 * POST dispatches on `action`:
 *   - `update` — trigger an in-place update; the server restarts so
 *     the response may not reach the client.
 *   - `configure` — persist `autoUpdate` config (cron schedule, etc.)
 */
export const GET = withApiHandler({}, async () => {
  const status = await checkForUpdates();
  const config = await getConfig();
  return NextResponse.json({ ...status, config });
});

const PostBody = z.object({
  action: z.enum(['update', 'configure']),
  version: z.string().optional(),
  autoUpdate: z.unknown().optional(),
});

export const POST = withApiHandler({ body: PostBody }, async ({ body }) => {
  if (body.action === 'update') {
    if (!body.version) {
      return NextResponse.json({ error: 'Version required' }, { status: 400 });
    }
    performUpdate(body.version).catch(err => logger.error('api:system:update', 'performUpdate failed', err));
    return NextResponse.json({ success: true, message: 'Update started. Service will restart.' });
  }
  // configure
  const config = await getConfig();
  const newConfig = {
    ...config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    autoUpdate: { ...config.autoUpdate, ...(body.autoUpdate as any) },
  };
  await saveConfig(newConfig);
  return NextResponse.json({ success: true, config: newConfig });
});
