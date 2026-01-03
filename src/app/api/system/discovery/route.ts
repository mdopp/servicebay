import { NextResponse } from 'next/server';
import { discoverSystemdServices } from '@/lib/discovery';
import { listNodes } from '@/lib/nodes';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  
  let connection;
  if (nodeName) {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
  }

  const services = await discoverSystemdServices(connection);
  return NextResponse.json(services);
}
