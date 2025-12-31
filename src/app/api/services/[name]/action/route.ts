import { NextResponse } from 'next/server';
import { startService, stopService, restartService, updateAndRestartService } from '@/lib/manager';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { action } = await request.json();

  try {
    let result;
    switch (action) {
      case 'start':
        result = await startService(name);
        break;
      case 'stop':
        result = await stopService(name);
        break;
      case 'restart':
        result = await restartService(name);
        break;
      case 'update':
        result = await updateAndRestartService(name);
        break;
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    return NextResponse.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
