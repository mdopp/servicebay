import { NextResponse } from 'next/server';
import { migrateService, DiscoveredService } from '@/lib/discovery';
import { listNodes } from '@/lib/nodes';

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const nodeName = searchParams.get('node');

    const body = await request.json();
    const { service, customName, dryRun } = body as { service: DiscoveredService, customName?: string, dryRun?: boolean };
    
    let connection;
    if (nodeName && nodeName !== 'local') {
        const nodes = await listNodes();
        connection = nodes.find(n => n.Name === nodeName);
        if (!connection) {
            return NextResponse.json({ error: `Node ${nodeName} not found` }, { status: 404 });
        }
    }

    const result = await migrateService(service, customName, dryRun, connection);
    
    if (dryRun) {
        return NextResponse.json({ plan: result });
    }
    
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Migration failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
