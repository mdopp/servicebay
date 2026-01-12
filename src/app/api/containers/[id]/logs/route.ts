import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const searchParams = request.nextUrl.searchParams;
  const nodeName = searchParams.get('node') || 'Local';

  try {
    const agent = agentManager.getAgent(nodeName);
    if (!agent) {
        return NextResponse.json({ logs: 'Agent not found' }, { status: 404 });
    }

    const response = await agent.sendCommand('exec', {
        command: `podman logs --tail 2000 ${id}`
    });

    if (response) {
        if (response.code === 0) {
             return NextResponse.json({ logs: response.stdout || 'No logs found.' });
        } else {
             return NextResponse.json({ logs: response.stderr || 'Error fetching logs' }, { status: 500 });
        }
    }
    
    return NextResponse.json({ logs: 'Unknown error' }, { status: 500 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ logs: msg }, { status: 500 });
  }
}
