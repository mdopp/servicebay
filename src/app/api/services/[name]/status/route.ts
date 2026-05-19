import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, { name: string }>(
  { query: Query },
  async ({ params, query }) => {
    const rawName = params?.name ?? '';
    let decoded = '';
    try { decoded = decodeURIComponent(rawName); } catch {
      return NextResponse.json({ error: 'invalid name encoding' }, { status: 400 });
    }
    const nodeName = query.node || 'Local';

    if (decoded === 'gateway' || decoded === 'Internet Gateway') {
      const { getConfig } = await import('@/lib/config');
      const { FritzBoxClient } = await import('@/lib/fritzbox/client');
      const config = await getConfig();
      if (config.gateway?.type === 'fritzbox') {
        try {
          const client = new FritzBoxClient(config.gateway);
          const status = await client.getStatus();
          return NextResponse.json({ status: status.connected ? 'active' : 'inactive' });
        } catch {
          return NextResponse.json({ status: 'unknown' });
        }
      }
      return NextResponse.json({ status: 'active' });
    }

    const check = ServiceName.safeParse(decoded);
    if (!check.success) {
      return NextResponse.json({ error: 'invalid name' }, { status: 400 });
    }
    const status = await ServiceManager.getServiceStatus(nodeName, check.data);
    return NextResponse.json({ status });
  },
);
