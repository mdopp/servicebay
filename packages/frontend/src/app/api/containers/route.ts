
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    const nodeName = query.node || 'Local';
    try {
      const agent = agentManager.getAgent(nodeName);
      if (!agent) {
        return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
      }
      // Use V4 'listContainers' command
      const list = await agent.sendCommand('listContainers');
      return NextResponse.json(list || []);
    } catch (e) {
      return apiError(e, { tag: 'api:containers:get', status: 500 });
    }
  },
);
