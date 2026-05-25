import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/api/requireSession';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { getPreflightStatus } from '@/lib/reverseProxy/preflight';
import { validatePublicDomain } from '@/lib/reverseProxy/migrateToPublic';

export const dynamic = 'force-dynamic';

const Query = z.object({ publicDomain: z.string().optional() });

/**
 * GET /api/system/reverse-proxy/preflight?publicDomain=<...>
 *
 * Reports the three-check gate for the LAN→Public migration (#265):
 *   - DNS resolves the target public domain to this install's WAN IP
 *   - HTTP-01 reachability on port 80 from the internet
 *   - Router port-forward for 80/443 (fritzbox health check)
 *
 * The UI (PR-2) polls this on a 5-s loop. Each tick re-runs the
 * letsdebug probe — pricey enough that the route returns immediately
 * with the most recent answer and skips background scheduling. PR-2
 * can throttle on the UI side.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ request, query }) => {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;

    const publicDomain = query.publicDomain ?? null;
    const domainError = validatePublicDomain(publicDomain);
    if (domainError) {
      return NextResponse.json({ error: domainError }, { status: 400 });
    }
    const status = await getPreflightStatus(publicDomain!);
    return NextResponse.json(status);
  } catch (error) {
    return apiError(error, { tag: 'api:system:reverse-proxy:preflight', status: 500 });
  }
});
