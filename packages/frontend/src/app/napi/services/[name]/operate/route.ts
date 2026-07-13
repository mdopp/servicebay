import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandlerParams } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { ServiceName } from '@/lib/api/schemas';

export const dynamic = 'force-dynamic';

/**
 * POST /napi/services/:name/operate — start / stop / restart a service from the
 * companion app (#2253, child 3 of epic #2242).
 *
 * The token-only, proxy-bypassed mutating twin of the browser
 * `/api/services/[name]/action` route. Reuses the SAME
 * `ServiceManager.{start,stop,restart}Service` lifecycle primitives — no second
 * code path — so a companion-app tap and a browser button do the identical
 * thing. `/api/services/[name]/action` stays the browser surface (cookie); this
 * is the `/napi/*` twin that never touches Authelia.
 *
 * TOKEN-GATED, `lifecycle`-scoped. `tokenScope: 'lifecycle'` in the
 * withApiHandlerParams OPTIONS (#2249 — the scope lives in the wrapper options
 * the gate actually reads, NOT an inner requireSession that would 401 a valid
 * Bearer). A `read`-only device token (the default the pairing flow #2251 mints)
 * is REJECTED here — start/stop/restart is a state change, so it needs the
 * `lifecycle` tier or higher; a read token can never operate a service.
 *
 * `update` is intentionally NOT offered here: a template/image upgrade is a
 * heavier operation the app surfaces via its own upgrade path, and keeping this
 * route to the three reversible lifecycle verbs matches the `lifecycle` scope
 * tier exactly (start/stop/restart, per apiScope.ts).
 */
const Body = z.object({
  action: z.enum(['start', 'stop', 'restart']),
});
const Query = z.object({ node: z.string().optional() });
type BodyT = z.infer<typeof Body>;
type QueryT = z.infer<typeof Query>;

export const POST = withApiHandlerParams<BodyT, QueryT, { name: string }>(
  { tokenScope: 'lifecycle', body: Body, query: Query },
  async ({ body, query, params }) => {
    const check = ServiceName.safeParse(decodeURIComponent(params.name));
    if (!check.success) {
      return NextResponse.json({ ok: false, error: 'invalid service name' }, { status: 400 });
    }
    const name = check.data;
    const nodeName = query.node || 'Local';

    try {
      switch (body.action) {
        case 'start':
          await ServiceManager.startService(nodeName, name);
          break;
        case 'stop':
          await ServiceManager.stopService(nodeName, name);
          break;
        case 'restart':
          await ServiceManager.restartService(nodeName, name);
          break;
      }
      return NextResponse.json({ ok: true, name, action: body.action });
    } catch (e) {
      return apiError(e, { tag: 'napi:services:operate', status: 500 });
    }
  },
);
