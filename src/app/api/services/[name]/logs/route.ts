import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getPodmanPs } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, { name: string }>(
  { query: Query },
  async ({ query, params }) => {
    const rawName = params?.name ?? '';
    let decoded = '';
    try { decoded = decodeURIComponent(rawName); } catch {
      return NextResponse.json({ error: 'invalid name encoding' }, { status: 400 });
    }
    const nodeName = query.node || 'Local';

    // Gateway special-case — no shell interpolation of `name` here.
    if (decoded === 'gateway' || decoded === 'Internet Gateway') {
      try {
        const { getConfig } = await import('@/lib/config');
        const { FritzBoxClient } = await import('@/lib/fritzbox/client');
        const config = await getConfig();
        if (config.gateway?.type === 'fritzbox') {
          const client = new FritzBoxClient(config.gateway);
          const status = await client.getStatus();
          return NextResponse.json({
            serviceLogs: status.deviceLog || 'No FritzBox logs available.',
            podmanLogs: '',
            podmanPs: [],
          });
        }
        return NextResponse.json({
          serviceLogs: 'Gateway not configured or not compatible with logs.',
          podmanLogs: '',
          podmanPs: [],
        });
      } catch (e) {
        return NextResponse.json({
          serviceLogs: `Error fetching gateway logs: ${e instanceof Error ? e.message : String(e)}`,
          podmanLogs: '',
          podmanPs: [],
        });
      }
    }

    const check = ServiceName.safeParse(decoded);
    if (!check.success) {
      return NextResponse.json({ error: 'invalid name' }, { status: 400 });
    }
    const name = check.data;

    const nodes = await listNodes();
    const connection = nodes.find(n => n.Name === nodeName);

    const [serviceLogsResult, podmanLogsResult, podmanPsResult] = await Promise.allSettled([
      ServiceManager.getServiceLogs(nodeName, name),
      ServiceManager.getPodmanLogs(nodeName),
      getPodmanPs(connection),
    ]);

    return NextResponse.json({
      serviceLogs: serviceLogsResult.status === 'fulfilled' ? serviceLogsResult.value : `Error: ${serviceLogsResult.reason}`,
      podmanLogs: podmanLogsResult.status === 'fulfilled' ? podmanLogsResult.value : `Error: ${podmanLogsResult.reason}`,
      podmanPs: podmanPsResult.status === 'fulfilled' ? podmanPsResult.value : [],
    });
  },
);
