import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandlerParams } from '@/lib/api/handler';
import { promotePendingSkill } from '@/lib/oscar/pendingSkills';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const Query = z.object({ node: z.string().optional() });

export const POST = withApiHandlerParams<undefined, z.infer<typeof Query>, { slug: string }>(
  { query: Query },
  async ({ query, params }) => {
    const slug = decodeURIComponent(params.slug);
    try {
      await promotePendingSkill(slug, query.node);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:oscar:pending-skills', `promote ${slug} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }

    // Restart Hermes so its loader picks up the new skill. The promote
    // already succeeded — surface a soft warning if the restart fails
    // rather than rolling back, because the file move is the load-
    // bearing part. The operator can restart Hermes from the services
    // page if this nudge doesn't take.
    const nodeName = query.node || 'Local';
    try {
      await ServiceManager.restartService(nodeName, 'hermes');
      return NextResponse.json({ ok: true, restarted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.warn('api:oscar:pending-skills', `promote ${slug} ok but hermes restart failed: ${message}`);
      return NextResponse.json({ ok: true, restarted: false, restartError: message });
    }
  },
);
