import { NextResponse } from 'next/server';
import { z } from 'zod';
import { discoverSystemdServices } from '@/lib/discovery';
import { listNodes } from '@/lib/nodes';
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
    const services = await discoverSystemdServices(connection);
    return NextResponse.json(services);
  },
);
