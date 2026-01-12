
import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const searchParams = request.nextUrl.searchParams;
  const nodeName = searchParams.get('node') || 'Local';
  
  try {
      const body = await request.json();
      const { action } = body;
      
      if (!['start', 'stop', 'restart', 'delete', 'kill'].includes(action)) {
          return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
      }

      const agent = agentManager.getAgent(nodeName);
      if (!agent) {
          return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }
      
      let cmd = '';
      if (action === 'delete') {
          cmd = `podman rm -f ${id}`;
      } else {
          cmd = `podman ${action} ${id}`;
      }

      const response = await agent.sendCommand('exec', { command: cmd });

      if (response && response.code === 0) {
          return NextResponse.json({ success: true, output: response.stdout });
      }
      
      return NextResponse.json({ error: 'Action failed', details: response }, { status: 500 });
      
  } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return NextResponse.json({ error: msg }, { status: 500 });
  }
}
