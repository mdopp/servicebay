import { NextResponse } from 'next/server';
import { getAllSystemServices } from '@/lib/manager';
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

  try {
    const services = await getAllSystemServices(connection);
    return NextResponse.json(services);
  } catch (error) {
    console.error('Failed to fetch system services:', error);
    return NextResponse.json({ error: 'Failed to fetch system services' }, { status: 500 });
  }
}
