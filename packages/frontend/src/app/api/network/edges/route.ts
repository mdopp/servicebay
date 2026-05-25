import { NextResponse } from 'next/server';
import { z } from 'zod';
import { NetworkStore } from '@/lib/network/store';
import { withApiHandler } from '@/lib/api/handler';
import { logger } from '@/lib/logger';
import crypto from 'crypto';

export const POST = withApiHandler({}, async ({ request }) => {
  try {
    const body = await request.json();
    const { source, target, port } = body;

    if (!source || !target) {
      return NextResponse.json({ error: 'Missing source or target' }, { status: 400 });
    }

    const edge = {
      id: `manual-${crypto.randomUUID()}`,
      source,
      target,
      label: port ? `:${port} (manual)` : 'Manual Link',
      port: port ? parseInt(port) : undefined,
      created_at: new Date().toISOString()
    };

    await NetworkStore.addEdge(edge);
    return NextResponse.json(edge);
  } catch (e) {
    logger.error('api:network:edges:post', 'Failed to add edge', e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
});

const DeleteQuery = z.object({ id: z.string().optional() });

export const DELETE = withApiHandler<undefined, z.infer<typeof DeleteQuery>>(
  { query: DeleteQuery },
  async ({ query }) => {
  try {
    const id = query.id;

    if (!id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    await NetworkStore.removeEdge(id);
    return NextResponse.json({ success: true });
  } catch (e) {
    logger.error('api:network:edges:delete', 'Failed to remove edge', e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
});
