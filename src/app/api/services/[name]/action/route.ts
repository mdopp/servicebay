import { NextResponse } from 'next/server';
import { startService, stopService, restartService, updateAndRestartService } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { action } = await request.json();
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  
  let connection;
  if (nodeName) {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
  }

  try {
    let result;
    switch (action) {
      case 'start':
        result = await startService(name, connection);
        break;
      case 'stop':
        result = await stopService(name, connection);
        break;
      case 'restart':
        result = await restartService(name, connection);
        break;
      case 'update':
        result = await updateAndRestartService(name, connection);
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
