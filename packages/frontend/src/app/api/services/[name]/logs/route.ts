import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getPodmanPs } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';
import { logTextForPrincipal } from '@/lib/api/principalRedaction';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

// `tokenScope: 'read'` (#2906) — the agent CLI's `logs` verb reads this with the
// container's delegated read token. Log retrieval writes nothing.
//
// Journals and `podman logs` catch every line a service prints at first run,
// including the admin password some images dump to stdout, so a token principal
// gets the text redacted — the same pass the MCP `get_logs` twin has run since
// #321 (#2943). A cookie operator's view is unchanged.
export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, { name: string }>(
  { query: Query, tokenScope: 'read' },
  async ({ query, params, auth }) => {
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
            serviceLogs: logTextForPrincipal(auth, status.deviceLog || 'No FritzBox logs available.'),
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
      serviceLogs: logTextForPrincipal(
        auth,
        serviceLogsResult.status === 'fulfilled' ? serviceLogsResult.value : `Error: ${serviceLogsResult.reason}`,
      ),
      podmanLogs: logTextForPrincipal(
        auth,
        podmanLogsResult.status === 'fulfilled' ? podmanLogsResult.value : `Error: ${podmanLogsResult.reason}`,
      ),
      podmanPs: podmanPsResult.status === 'fulfilled' ? podmanPsResult.value : [],
    });
  },
);
