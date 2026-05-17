import { NextResponse } from 'next/server';
import { checkForUpdates, performUpdate } from '@/lib/updater';
import { getConfig, saveConfig } from '@/lib/config';
import { apiError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

import { requireSession } from '@/lib/api/requireSession';
export async function GET() {
  try {
    const status = await checkForUpdates();
    const config = await getConfig();
    return NextResponse.json({ ...status, config });
  } catch (e) {
    return apiError(e, { tag: 'api:system:update:get', status: 500 });
  }
}

export async function POST(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  try {
    const body = await request.json();
    
    if (body.action === 'update') {
      if (!body.version) {
        return NextResponse.json({ error: 'Version required' }, { status: 400 });
      }
      // This will restart the server, so the response might not reach the client
      performUpdate(body.version).catch((err) => logger.error('api:system:update', 'performUpdate failed', err));
      return NextResponse.json({ success: true, message: 'Update started. Service will restart.' });
    }
    
    if (body.action === 'configure') {
      const config = await getConfig();
      const newConfig = {
        ...config,
        autoUpdate: {
          ...config.autoUpdate,
          ...body.autoUpdate
        }
      };
      await saveConfig(newConfig);
      
      // We need to notify the main server process to reschedule
      // Since we are in the same process (Next.js standalone usually runs in same process as custom server if imported),
      // but here Next.js handles the API.
      // If we use a custom server, we might need a way to signal it.
      // For now, a restart is the easiest way to apply schedule changes.
      
      return NextResponse.json({ success: true, config: newConfig });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    return apiError(e, { tag: 'api:system:update:post', status: 500 });
  }
}
