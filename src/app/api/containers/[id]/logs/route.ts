import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { ContainerId } from '@/lib/api/schemas';
import { parseRouteParam } from '@/lib/api/validate';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const parsed = await parseRouteParam(params, 'id', ContainerId);
  if (!parsed.ok) return parsed.response;
  const id = parsed.value;
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
    return apiError(error, { tag: 'api:containers:logs', status: 500 });
  }
}
