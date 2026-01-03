import { NextResponse } from 'next/server';
import { getContainerLogs } from '@/lib/manager';
import { listNodes } from '@/lib/nodes';

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

  const logs = await getContainerLogs(id, connection);
  return NextResponse.json({ logs });
}
