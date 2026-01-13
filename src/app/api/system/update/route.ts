import { NextResponse } from 'next/server';
import { checkForUpdates, performUpdate } from '@/lib/updater';
import { getConfig, saveConfig } from '@/lib/config';

export async function GET() {
  try {
    const status = await checkForUpdates();
    const config = await getConfig();
    return NextResponse.json({ ...status, config });
  } catch (e) {
    console.error('[API] /update error:', e);
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    if (body.action === 'update') {
      if (!body.version) {
        return NextResponse.json({ error: 'Version required' }, { status: 400 });
      }
      // This will restart the server, so the response might not reach the client
      performUpdate(body.version).catch(console.error);
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
    const message = e instanceof Error ? e.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
