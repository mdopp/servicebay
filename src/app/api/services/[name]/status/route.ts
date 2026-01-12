import { NextResponse } from 'next/server';
import { getServiceStatus } from '@/lib/manager';
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
  
  if (name === 'gateway' || name === 'Internet Gateway') {
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
        return NextResponse.json({ status: 'active' }); // Assume active if just a gateway placeholder
  }

  try {
    const status = await getServiceStatus(name, connection);
    return NextResponse.json({ status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
