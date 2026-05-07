import { NextResponse } from 'next/server';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { getPodmanPs } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';
import { ServiceName } from '@/lib/api/schemas';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const resolved = await params;
  const rawName = resolved?.name ?? '';
  let decoded = '';
  try { decoded = decodeURIComponent(rawName); } catch {
    return NextResponse.json({ error: 'invalid name encoding' }, { status: 400 });
  }
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node') || 'Local';

  // Gateway special-case: this branch never interpolates `name` into a shell command.
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
    getPodmanPs(connection)
  ]);

  return NextResponse.json({
    serviceLogs: serviceLogsResult.status === 'fulfilled' ? serviceLogsResult.value : `Error: ${serviceLogsResult.reason}`,
    podmanLogs: podmanLogsResult.status === 'fulfilled' ? podmanLogsResult.value : `Error: ${podmanLogsResult.reason}`,
    podmanPs: podmanPsResult.status === 'fulfilled' ? podmanPsResult.value : []
  });
}
