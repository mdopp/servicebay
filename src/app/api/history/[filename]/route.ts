import { NextResponse } from 'next/server';
import { getHistory, getSnapshotContent } from '@/lib/history';

export async function GET(request: Request, { params }: { params: Promise<{ filename: string }> }) {
  const { filename } = await params;
  const { searchParams } = new URL(request.url);
  const timestamp = searchParams.get('timestamp');

  if (timestamp) {
    try {
      const content = await getSnapshotContent(filename, timestamp);
      return new NextResponse(content);
    } catch {
      return NextResponse.json({ error: 'Snapshot not found' }, { status: 404 });
    }
  } else {
    const history = await getHistory(filename);
    return NextResponse.json(history);
  }
}
