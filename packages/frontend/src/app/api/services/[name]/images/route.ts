import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ServiceName } from '@/lib/api/schemas';
import { withApiHandlerParams } from '@/lib/api/handler';
import { getServiceImageStatus } from '@/lib/services/imageStatus';
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
    try {
      return NextResponse.json(await getServiceImageStatus(query.node || 'Local', check.data));
    } catch (error) {
      return apiError(error, { tag: 'api:services:images', status: 500 });
    }
  },
);
