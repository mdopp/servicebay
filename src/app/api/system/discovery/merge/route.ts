
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { cookies } from 'next/headers';
import { mergeServices, type DiscoveredService } from '@/lib/migration';
import { listNodes } from '@/lib/nodes';
import { decrypt } from '@/lib/auth';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';
import { logger } from '@/lib/logger';

const Query = z.object({ node: z.string().optional() });

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
    logger.warn('api:system:discovery:merge', 'Failed to resolve actor from session', error);
  }

  return 'unknown';
}

export const POST = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ request, query }) => {
  try {
    const nodeName = query.node;

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
    return apiError(error, { tag: 'api:system:discovery:merge', status: 500 });
  }
});
