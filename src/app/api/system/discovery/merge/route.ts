
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { mergeServices, DiscoveredService } from '@/lib/discovery';
import { listNodes } from '@/lib/nodes';
import { decrypt } from '@/lib/auth';

async function resolveActor(request: Request): Promise<string> {
  const forwarded = request.headers.get('x-forwarded-user') || request.headers.get('remote-user');
  if (forwarded) {
    return forwarded;
  }

  try {
    const cookieStore = await cookies();
    const sessionToken = cookieStore.get('session')?.value;
    if (sessionToken) {
      const payload = await decrypt(sessionToken);
      if (payload?.user) {
        return String(payload.user);
      }
    }
  } catch (error) {
    console.warn('Failed to resolve actor from session', error);
  }

  return 'unknown';
}

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

    const actor = await resolveActor(request);
    const result = await mergeServices(services, newName, {
      dryRun,
      connection,
      initiator: actor
    });
    
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
