import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { ContainerId } from '@/lib/api/schemas';
import { apiError } from '@/lib/api/errors';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, { id: string }>(
  { query: Query },
  async ({ query, params }) => {
  const check = ContainerId.safeParse(params.id);
  if (!check.success) {
    return NextResponse.json({ logs: 'invalid id' }, { status: 400 });
  }
  const id = check.data;
  const nodeName = query.node || 'Local';

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
});
