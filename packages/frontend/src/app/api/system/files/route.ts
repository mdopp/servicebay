import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getExecutor } from '@/lib/executor';
import { listNodes } from '@/lib/nodes';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({
  path: z.string().optional(),
  node: z.string().optional(),
});

export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
  const path = query.path;
  const nodeName = query.node;

  if (!path) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  let connection;
  if (nodeName && nodeName !== 'Local') {
    const nodes = await listNodes();
    connection = nodes.find(node => node.Name === nodeName);
    if (!connection) {
      return NextResponse.json({ error: `Node ${nodeName} not found` }, { status: 404 });
    }
  }

  try {
    const executor = getExecutor(connection);
    const content = await executor.readFile(path);
    return NextResponse.json({ content });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('api:system:files', 'Failed to read file content', error);
    return NextResponse.json({ error: `Failed to read file: ${message}` }, { status: 500 });
  }
});
