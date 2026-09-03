import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { withApiHandler } from '@/lib/api/handler';
import { readFileOnNode, NodeNotFoundError } from '@/lib/nodes/remoteFile';

export const dynamic = 'force-dynamic';

const Query = z.object({
  path: z.string().optional(),
  node: z.string().optional(),
});

export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
  const path = query.path;

  if (!path) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  try {
    const content = await readFileOnNode(path, query.node);
    return NextResponse.json({ content });
  } catch (error) {
    if (error instanceof NodeNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('api:system:files', 'Failed to read file content', error);
    return NextResponse.json({ error: `Failed to read file: ${message}` }, { status: 500 });
  }
});
