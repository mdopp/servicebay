import { NextResponse } from 'next/server';
import { getContainerInspect } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const nodeName = searchParams.get('node');
  
  let connection;
  if (nodeName) {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
  }

  const container = await getContainerInspect(id, connection);
  
  if (!container) {
    return NextResponse.json({ error: 'Container not found' }, { status: 404 });
  }

  return NextResponse.json(container);
}
