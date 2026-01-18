import { NextResponse } from 'next/server';
import { getExecutor } from '@/lib/executor';
import { listNodes } from '@/lib/nodes';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get('path');
  const nodeName = searchParams.get('node');

  if (!path) {
    return NextResponse.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  let connection;
  if (nodeName && nodeName !== 'Local') {
    const nodes = await listNodes();
    connection = nodes.find(node => node.Name === nodeName);
    if (!connection) {
      return NextResponse.json({ error: `Node ${nodeName} not found` }, { status: 404 });
    }
  }

  try {
    const executor = getExecutor(connection);
    const content = await executor.readFile(path);
    return NextResponse.json({ content });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to read file content:', error);
    return NextResponse.json({ error: `Failed to read file: ${message}` }, { status: 500 });
  }
}
