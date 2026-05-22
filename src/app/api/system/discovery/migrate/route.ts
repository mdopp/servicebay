import { NextResponse } from 'next/server';
import { z } from 'zod';
import { migrateService, type DiscoveredService } from '@/lib/migration';
import { listNodes } from '@/lib/nodes';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';

const Query = z.object({ node: z.string().optional() });

export const POST = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ request, query }) => {
  try {
    const nodeName = query.node;

    const body = await request.json();
    const { service, customName, dryRun } = body as { service: DiscoveredService, customName?: string, dryRun?: boolean };
    
    let connection;
    if (nodeName && nodeName.toLowerCase() !== 'local') {
        const nodes = await listNodes();
        connection = nodes.find(n => n.Name === nodeName);
        if (!connection) {
            return NextResponse.json({ error: `Node ${nodeName} not found` }, { status: 404 });
        }
    }
    // Note: For 'Local' node, connection remains undefined which is correct.
    // getExecutor handles undefined by using the Local agent.

    const result = await migrateService(service, customName, dryRun, connection);
    
    if (dryRun) {
        return NextResponse.json({ plan: result });
    }
    
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return apiError(error, { tag: 'api:system:discovery:migrate', status: 500 });
  }
});
