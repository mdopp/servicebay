import { NextResponse } from 'next/server';
import { migrateService, DiscoveredService } from '@/lib/discovery';

export async function POST(request: Request) {
  try {
    const service: DiscoveredService = await request.json();
    await migrateService(service);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Migration failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
