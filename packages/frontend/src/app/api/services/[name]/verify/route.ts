import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { verifyService } from '@/lib/services/serviceVerifyRun';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

/**
 * GET /api/services/[name]/verify (#3021) — is this deployment actually done?
 *
 * `tokenScope: 'read'`. Six measurements, no mutation: container health and its
 * last health-log line, restart state, whether the running image is the one the
 * registry publishes, whether the application is in the image rather than in
 * the pod spec, whether the proxy route names a service that exists, and
 * whether the public URL answers when asked FROM the box.
 *
 * It exists because the same six points lived as a catalog checklist (#3019)
 * and prose only works when somebody opens it — which a session does least at
 * the moment it believes it is finished. The same health-probe fault shipped
 * twice in two days, the second time with that checklist already written.
 *
 * What it does NOT cover, deliberately: whether the page renders without
 * console errors. That needs a browser the box does not have, and pretending to
 * cover it would make a green answer mean less than it does.
 */
export const GET = withApiHandlerParams<undefined, z.infer<typeof Query>, { name: string }>(
  { query: Query, tokenScope: 'read' },
  async ({ query, params }) => {
    const check = ServiceName.safeParse(decodeURIComponent(params.name));
    if (!check.success) {
      return NextResponse.json({ error: 'invalid name' }, { status: 400 });
    }
    const node = query.node || 'Local';
    // A failed listing is not an empty listing: only claim absence when we
    // actually enumerated (the lesson from the images route).
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
      return NextResponse.json(await verifyService(node, check.data));
    } catch (error) {
      return apiError(error, { tag: 'api:services:verify', status: 500 });
    }
  },
);
