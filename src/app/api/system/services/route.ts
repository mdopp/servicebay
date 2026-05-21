import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getAllSystemServices } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    let connection;
    if (query.node) {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === query.node);
    }
    try {
      const services = await getAllSystemServices(connection);
      return NextResponse.json(services);
    } catch (error) {
      logger.error('api:system:services', 'Failed to fetch system services', error);
      return NextResponse.json({ error: 'Failed to fetch system services' }, { status: 500 });
    }
  },
);
