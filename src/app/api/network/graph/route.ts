import { NextResponse } from 'next/server';
import { NetworkService } from '@/lib/network/service';

export async function GET() {
  try {
    const service = new NetworkService();
    const graph = await service.getGraph();
    return NextResponse.json(graph);
  } catch (e) {
    console.error('Network Graph Error:', e);
    return NextResponse.json({ error: 'Failed to generate network graph' }, { status: 500 });
  }
}
