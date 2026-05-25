import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { ContainerId } from '@/lib/api/schemas';
import { apiError } from '@/lib/api/errors';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

export const POST = withApiHandlerParams<undefined, z.infer<typeof Query>, { id: string }>(
  { query: Query },
  async ({ request, query, params }) => {
  const check = ContainerId.safeParse(params.id);
  if (!check.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const id = check.data;
  const nodeName = query.node || 'Local';

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
});
