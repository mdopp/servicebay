import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Body = z.object({
  action: z.enum(['start', 'stop', 'restart', 'update', 'force-update']),
  /**
   * `force-update` only (#2397): delete the local image and pull it from
   * scratch instead of a plain pull-if-newer. The fallback for a genuinely
   * stuck image — see forceUpdate.ts.
   */
  mode: z.enum(['pull', 'fresh']).optional(),
});
const Query = z.object({ node: z.string().optional() });

/**
 * POST /api/services/[name]/action — start | stop | restart | update | force-update.
 *
 * `tokenScope: 'lifecycle'` (#2990) — the same tier this route's MCP twin
 * `manage_service` has carried since #2397, and the tier `/api/install/start`
 * already carries. It was cookie-only until now, which did not make the box
 * safer: the agent CLI had no verb for it, so a scoped session that needed to
 * move a service onto a new image was sent to the raw `/mcp` endpoint with its
 * token on the command line. The token already decided; only the door was
 * wrong (ADR 0017).
 *
 * `force-update` is the action the CLI's `update` verb speaks. Note the
 * asymmetry with the plain `update` action below it: `update` restarts without
 * proving the image moved, `force-update` returns per-image before/after
 * digests and a `stale` flag, which is what lets a caller tell a real update
 * from a no-op (#2983).
 */
export const POST = withApiHandlerParams<z.infer<typeof Body>, z.infer<typeof Query>, { name: string }>(
  { body: Body, query: Query, tokenScope: 'lifecycle' },
  async ({ body, query, params }) => {
    const check = ServiceName.safeParse(decodeURIComponent(params.name));
    if (!check.success) {
      return NextResponse.json({ error: 'invalid name' }, { status: 400 });
    }
    const name = check.data;
    const nodeName = query.node || 'Local';

    switch (body.action) {
      case 'start':
        await ServiceManager.startService(nodeName, name);
        return NextResponse.json(await ServiceManager.getServiceStatus(nodeName, name));
      case 'stop':
        await ServiceManager.stopService(nodeName, name);
        return NextResponse.json(await ServiceManager.getServiceStatus(nodeName, name));
      case 'restart':
        await ServiceManager.restartService(nodeName, name);
        return NextResponse.json(await ServiceManager.getServiceStatus(nodeName, name));
      case 'update':
        return NextResponse.json(await ServiceManager.updateAndRestartService(nodeName, name));
      case 'force-update':
        // Re-checks the registry, re-pulls, and force-recreates the containers
        // so the unit cannot come back up on the cached image (#2397).
        return NextResponse.json(
          await ServiceManager.forceUpdateService(nodeName, name, { fresh: body.mode === 'fresh' }),
        );
    }
  },
);
