import { NextResponse } from 'next/server';
import { 
  stopContainer, 
  forceStopContainer, 
  restartContainer, 
  forceRestartContainer, 
  deleteContainer 
} from '@/lib/manager';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { action } = await request.json();

  try {
    switch (action) {
      case 'stop':
        await stopContainer(id);
        break;
      case 'force-stop':
        await forceStopContainer(id);
        break;
      case 'restart':
        await restartContainer(id);
        break;
      case 'force-restart':
        await forceRestartContainer(id);
        break;
      case 'delete':
        await deleteContainer(id);
        break;
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error(`Failed to perform action ${action} on container ${id}:`, error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
