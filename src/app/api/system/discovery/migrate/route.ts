import { NextResponse } from 'next/server';
import { migrateService, DiscoveredService } from '@/lib/discovery';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { service, customName, dryRun } = body as { service: DiscoveredService, customName?: string, dryRun?: boolean };
    
    const result = await migrateService(service, customName, dryRun);
    
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
