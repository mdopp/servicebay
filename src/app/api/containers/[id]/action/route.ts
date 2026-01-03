import { NextResponse } from 'next/server';
import { 
  stopContainer, 
  forceStopContainer, 
  restartContainer, 
  forceRestartContainer, 
  deleteContainer 
} from '@/lib/manager';
import { listNodes } from '@/lib/nodes';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action } = await request.json();
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  
  let connection;
  if (nodeName) {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
  }

  try {
    switch (action) {
      case 'stop':
        await stopContainer(id, connection);
        break;
      case 'force-stop':
        await forceStopContainer(id, connection);
        break;
      case 'restart':
        await restartContainer(id, connection);
        break;
      case 'force-restart':
        await forceRestartContainer(id, connection);
        break;
      case 'delete':
        await deleteContainer(id, connection);
        break;
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    console.error(`Failed to perform action ${action} on container ${id}:`, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
