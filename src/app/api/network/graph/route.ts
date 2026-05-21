import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NetworkService } from '@/lib/network/service';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

const Query = z.object({ node: z.string().optional() });

export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    try {
      const service = new NetworkService();
      const graph = await service.getGraph(query.node);
      return NextResponse.json(graph);
    } catch (e) {
      logger.error('api:network:graph', 'Network graph error', e);
      return NextResponse.json({ error: 'Failed to generate network graph' }, { status: 500 });
    }
  },
);
