import { NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getPodmanPs } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node') || 'Local';

  // Special handling for Internet Gateway (FritzBox)
  if (name === 'gateway' || name === 'Internet Gateway') {
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
                  podmanPs: []
              });
          } else {
             return NextResponse.json({
                  serviceLogs: 'Gateway not configured or not compatible with logs.',
                  podmanLogs: '',
                  podmanPs: []
              });
          }
      } catch (e) {
          return NextResponse.json({
              serviceLogs: `Error fetching gateway logs: ${e instanceof Error ? e.message : String(e)}`,
              podmanLogs: '',
              podmanPs: []
          });
      }
  }

  // getPodmanPs still needs a connection object for now (stays in manager.ts)
  const nodes = await listNodes();
  const connection = nodes.find(n => n.Name === nodeName);

  const [serviceLogsResult, podmanLogsResult, podmanPsResult] = await Promise.allSettled([
    ServiceManager.getServiceLogs(nodeName, name),
    ServiceManager.getPodmanLogs(nodeName),
    getPodmanPs(connection)
  ]);

  return NextResponse.json({
    serviceLogs: serviceLogsResult.status === 'fulfilled' ? serviceLogsResult.value : `Error: ${serviceLogsResult.reason}`,
    podmanLogs: podmanLogsResult.status === 'fulfilled' ? podmanLogsResult.value : `Error: ${podmanLogsResult.reason}`,
    podmanPs: podmanPsResult.status === 'fulfilled' ? podmanPsResult.value : []
  });
}
