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
