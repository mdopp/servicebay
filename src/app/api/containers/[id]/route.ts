
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
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
    }

    // Use 'exec' command to inspect
    // We inspect the container to get full details
    const response = await agent.sendCommand('exec', {
        command: `podman inspect ${id}`
    });

    if (response && response.code === 0) {
        const data = JSON.parse(response.stdout);
        if (Array.isArray(data) && data.length > 0) {
            return NextResponse.json(data[0]);
        }
    }
    
    return NextResponse.json({ error: 'Container not found or inspect failed', details: response }, { status: 404 });

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
