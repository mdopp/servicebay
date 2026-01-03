
import { NextResponse } from 'next/server';
import { mergeServices, DiscoveredService } from '@/lib/discovery';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { services, newName } = body as { services: DiscoveredService[], newName: string };
    
    if (!services || services.length < 2) {
        return NextResponse.json({ error: 'At least two services are required for merge' }, { status: 400 });
    }
    
    if (!newName) {
        return NextResponse.json({ error: 'New service name is required' }, { status: 400 });
    }

    await mergeServices(services, newName);
    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    console.error('Merge failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
