import { NextResponse } from 'next/server';
import { getServiceLogs, getPodmanLogs, getPodmanPs } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  
  let connection;
  if (nodeName) {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
  }
  
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

  const [serviceLogs, podmanLogs, podmanPs] = await Promise.all([
    getServiceLogs(name, connection),
    getPodmanLogs(connection),
    getPodmanPs(connection)
  ]);

  return NextResponse.json({
    serviceLogs,
    podmanLogs,
    podmanPs
  });
}
