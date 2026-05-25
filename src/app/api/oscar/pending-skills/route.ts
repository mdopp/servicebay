import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { listPendingSkills } from '@/lib/oscar/pendingSkills';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
    try {
      const skills = await listPendingSkills(query.node);
      return NextResponse.json({ skills });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:oscar:pending-skills', 'list failed', error);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  },
);
