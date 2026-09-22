import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { readHostPorts } from '@/lib/services/hostPortsRun';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

/**
 * GET /api/system/ports (#3028) — what is listening on the box, and what is free.
 *
 * `tokenScope: 'read'`. It reads the node's listener table and the service
 * list; it binds nothing and changes nothing.
 *
 * It exists because a session inside a pod is structurally blind here: its own
 * network namespace shows it no host ports at all, so "is 3000 free?" is a
 * question it can only guess at. `services` is not the answer — the ports that
 * bit were held by ServiceBay's own backend and by adguard, and neither appears
 * in a service listing.
 *
 * It does NOT resolve a port for anyone. A port is part of a service's
 * identity: the proxy route, the firewall rule and the healthcheck annotation
 * all name it, so silently moving one leaves a definition that lies.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query, tokenScope: 'read' },
  async ({ query }) => {
    try {
      return NextResponse.json(await readHostPorts(query.node || 'Local'));
    } catch (error) {
      return apiError(error, { tag: 'api:system:ports', status: 500 });
    }
  },
);
