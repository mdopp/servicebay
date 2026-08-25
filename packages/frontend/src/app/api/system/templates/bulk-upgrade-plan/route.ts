import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { planBulkTemplateUpgrade } from '@/lib/install/bulkUpgradePlan';

export const dynamic = 'force-dynamic';

/**
 * POST /api/system/templates/bulk-upgrade-plan
 *
 * The preview step of a collective template upgrade (#2602). Answers, for a
 * chosen set of lagging services: in what order would they deploy, which
 * migration scripts would run, which of them cannot roll out at all — and it
 * answers all three BEFORE anything is deployed.
 *
 * A plan is read-only. It deploys nothing; the run itself still goes through
 * `POST /api/install/start` like every other install, so the runner's
 * dependency gate, migration handling and per-service outcome reporting are
 * the same ones a single-service upgrade gets (#2600/#2601).
 *
 * `names` omitted = every service behind its shipped template version.
 */
const Body = z.object({
  names: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).optional(),
  source: z.string().optional(),
});

export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body, tokenScope: 'read' },
  async ({ body }) => {
    try {
      const plan = await planBulkTemplateUpgrade(body.names, body.source);
      return NextResponse.json(plan);
    } catch (e) {
      return apiError(e, { tag: 'api:system:templates:bulk-upgrade-plan', status: 500 });
    }
  },
);
