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
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const id = check.data;
  const nodeName = query.node || 'Local';

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
    return apiError(error, { tag: 'api:containers:inspect', status: 500 });
  }
});
