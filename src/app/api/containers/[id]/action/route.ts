
import { NextRequest, NextResponse } from 'next/server';
import { agentManager } from '@/lib/agent/manager';
import { ContainerId } from '@/lib/api/schemas';
import { parseRouteParam } from '@/lib/api/validate';
import { apiError } from '@/lib/api/errors';

import { requireSession } from '@/lib/api/requireSession';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  const parsed = await parseRouteParam(params, 'id', ContainerId);
  if (!parsed.ok) return parsed.response;
  const id = parsed.value;
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
      return apiError(error, { tag: 'api:containers:action', status: 500 });
  }
}
