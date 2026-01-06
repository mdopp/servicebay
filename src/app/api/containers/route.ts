import { NextResponse } from 'next/server';
import { getEnrichedContainers } from '@/lib/manager';
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

  const [enriched] = await getEnrichedContainers(connection);

  return NextResponse.json(enriched);
}
