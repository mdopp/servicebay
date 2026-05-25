import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandlerParams } from '@/lib/api/handler';
import { rejectPendingSkill } from '@/lib/oscar/pendingSkills';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

export const DELETE = withApiHandlerParams<undefined, z.infer<typeof Query>, { slug: string }>(
  { query: Query },
  async ({ query, params }) => {
    try {
      await rejectPendingSkill(decodeURIComponent(params.slug), query.node);
      return NextResponse.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:oscar:pending-skills', `reject ${params.slug} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
