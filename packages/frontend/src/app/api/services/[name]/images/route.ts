import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';
import { getServiceImageStatus } from '@/lib/services/imageStatus';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

/**
 * GET /api/services/[name]/images (#2995) — is what this service pulls actually
 * published, pulled, and current?
 *
 * `tokenScope: 'read'`. It inspects a manifest (a few KB) and the local image
 * store; it pulls nothing, stops nothing, recreates nothing. The mutating twin
 * next door is `POST …/action` with `force-update`.
 *
 * This exists because an agent on this box cannot build an image, so when its
 * CI path breaks it has no way to learn that **nothing was ever published** —
 * and a session that cannot learn that invents something else to try. The
 * answer is one read, and the `problem` field says which kind of "no" it is:
 * `not-published` (your build never landed) is a different next move from
 * `unreachable` (retry) and `unauthorized` (no pull credential).
 */
export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, { name: string }>(
  { query: Query, tokenScope: 'read' },
  async ({ query, params }) => {
    const check = ServiceName.safeParse(decodeURIComponent(params.name));
    if (!check.success) {
      return NextResponse.json({ error: 'invalid name' }, { status: 400 });
    }
    const node = query.node || 'Local';
    // A name no service has is a bad request, not a broken server. Without
    // this, `getServiceFiles` throws and the caller gets
    // `500 {"error":"Internal error"}` — measured on 5.41.0 — which is the
    // same unreadable refusal this verb exists to replace, shipped inside the
    // verb itself. Through the ServiceManager facade, like every route
    // (`service-manager-single-mutation-path`).
    //
    // A listing that FAILS is not an empty listing. Treating the two alike
    // would answer "no service named X" for every name the moment a node is
    // unreachable — sending someone to hunt a typo that is not there. We only
    // claim absence when we actually enumerated.
    const listed = await ServiceManager.listServices(node).then(
      s => ({ ok: true as const, services: s }),
      () => ({ ok: false as const, services: [] }),
    );
    if (listed.ok && !listed.services.some(s => s.name === check.data)) {
      return NextResponse.json(
        { error: `No service named "${check.data}" on node "${node}". Check \`servicebay services\` for the name.` },
        { status: 404 },
      );
    }
    try {
      return NextResponse.json(await getServiceImageStatus(node, check.data));
    } catch (error) {
      return apiError(error, { tag: 'api:services:images', status: 500 });
    }
  },
);
