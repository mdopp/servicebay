
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
        return new NextResponse('Agent not found', { status: 404 });
    }

    // Fetch last 2000 lines
    // We cannot easily stream via the current request-response model without blocking the agent
    // So we fetch a chunk.
    const response = await agent.sendCommand('exec', {
        command: `podman logs --tail 2000 ${id}`
    });

    if (response) {
        if (response.code === 0) {
             return new NextResponse(response.stdout);
        } else {
             return new NextResponse(response.stderr || 'Error fetching logs', { status: 500 });
        }
    }
    
    return new NextResponse('Unknown error', { status: 500 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new NextResponse(msg, { status: 500 });
  }
}
