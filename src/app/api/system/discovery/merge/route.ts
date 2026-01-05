
import { NextResponse } from 'next/server';
import { mergeServices, DiscoveredService } from '@/lib/discovery';
import { listNodes } from '@/lib/nodes';

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const nodeName = searchParams.get('node');

    const body = await request.json();
    const { services, newName, dryRun } = body as { services: DiscoveredService[], newName: string, dryRun?: boolean };
    
    if (!services || services.length < 2) {
        return NextResponse.json({ error: 'At least two services are required for merge' }, { status: 400 });
    }
    
    if (!newName) {
        return NextResponse.json({ error: 'New service name is required' }, { status: 400 });
    }

    let connection;
    if (nodeName && nodeName !== 'local') {
        const nodes = await listNodes();
        connection = nodes.find(n => n.Name === nodeName);
        if (!connection) {
            return NextResponse.json({ error: `Node ${nodeName} not found` }, { status: 404 });
        }
    }

    const result = await mergeServices(services, newName, dryRun, connection);
    
    if (dryRun) {
        return NextResponse.json({ plan: result });
    }

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Merge failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
