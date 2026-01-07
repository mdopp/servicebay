import { NextResponse } from 'next/server';
import { NetworkService } from '@/lib/network/service';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const node = searchParams.get('node');

  try {
    const service = new NetworkService();
    // Pass node parameter to getGraph
    const graph = await service.getGraph(node || undefined);
    return NextResponse.json(graph);
  } catch (e) {
    console.error('Network Graph Error:', e);
    return NextResponse.json({ error: 'Failed to generate network graph' }, { status: 500 });
  }
}
