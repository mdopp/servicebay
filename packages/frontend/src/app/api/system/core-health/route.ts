/**
 * GET /api/system/core-health (#635 / Phase 5C)
 *
 * UI-shaped summary of every `tier: core` stack that isn't fully
 * `health.ready === true`. Drives the <CoreHealthBanner> and the
 * tier-gate refusal modal in <StackCard>.
 *
 * Returns `{ degraded: DegradedCoreEntry[] }`. Empty array = core is
 * healthy (banner stays hidden, feature-stack installs are allowed).
 */
import { NextResponse } from 'next/server';
import { apiError } from '@/lib/api/errors';
import { getDegradedCoreSummary } from '@/lib/install/stackHealth';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({}, async () => {
  try {
    const degraded = await getDegradedCoreSummary();
    return NextResponse.json({ degraded });
  } catch (e) {
    return apiError(e, { tag: 'api:system:core-health', status: 500 });
  }
});
