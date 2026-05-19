import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Body = z.object({ newName: z.string().min(1) });
const Query = z.object({ node: z.string().optional() });

export const POST = withApiHandlerParams<z.infer<typeof Body>, z.infer<typeof Query>, { name: string }>(
  { body: Body, query: Query },
  async ({ body, query, params }) => {
    const oldCheck = ServiceName.safeParse(decodeURIComponent(params.name));
    if (!oldCheck.success) {
      return NextResponse.json({ error: 'invalid name' }, { status: 400 });
    }
    const newCheck = ServiceName.safeParse(body.newName);
    if (!newCheck.success) {
      return NextResponse.json({ error: 'invalid newName' }, { status: 400 });
    }
    const nodeName = query.node || 'Local';
    await ServiceManager.renameService(nodeName, oldCheck.data, newCheck.data);
    return NextResponse.json({ success: true });
  },
);
