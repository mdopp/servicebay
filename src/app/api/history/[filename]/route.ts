import { NextResponse } from 'next/server';
import { getHistory, getSnapshotContent } from '@/lib/history';
import { listNodes } from '@/lib/nodes';
import { BackupFileName } from '@/lib/api/schemas';
import { parseRouteParam } from '@/lib/api/validate';

const TIMESTAMP_RE = /^[0-9_\-]{1,64}$/;

export async function GET(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const parsed = await parseRouteParam(params, 'filename', BackupFileName);
  if (!parsed.ok) return parsed.response;
  const filename = parsed.value;
  const { searchParams } = new URL(request.url);
  const timestamp = searchParams.get('timestamp');
  const nodeName = searchParams.get('node');

  if (timestamp !== null && !TIMESTAMP_RE.test(timestamp)) {
    return NextResponse.json({ error: 'invalid timestamp' }, { status: 400 });
  }

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
