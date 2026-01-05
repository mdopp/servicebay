import { NextResponse } from 'next/server';
import { getHistory, getSnapshotContent } from '@/lib/history';
import { listNodes } from '@/lib/nodes';

export async function GET(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  const { searchParams } = new URL(request.url);
  const timestamp = searchParams.get('timestamp');
  const nodeName = searchParams.get('node');

  let connection;
  if (nodeName && nodeName !== 'local') {
      const nodes = await listNodes();
      connection = nodes.find(n => n.Name === nodeName);
  }

  if (timestamp) {
    try {
      const content = await getSnapshotContent(filename, timestamp, connection);
      return new NextResponse(content);
    } catch {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }
  } else {
    const history = await getHistory(filename, connection);
    return NextResponse.json(history);
  }
}
