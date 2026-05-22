import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import {
  applyMigrationToPublic,
  validatePublicDomain,
} from '@/lib/reverseProxy/migrateToPublic';

export const dynamic = 'force-dynamic';

/**
 * POST /api/system/reverse-proxy/migrate-to-public
 *
 * Plans (or applies) the LAN→Public migration locked in on #265.
 *
 * Body:
 *   { publicDomain: string; dryRun?: boolean }
 *
 * `dryRun: true` returns the plan + per-step would-be outcomes without
 * touching NPM, Authelia, or config. The default (`dryRun: false`)
 * runs the plan: each step's failure surfaces in `errors[]` but does
 * not abort subsequent steps (idempotent + retryable per the locked
 * design).
 *
 * Auth-gated via `requireSession`. No feature flag — the UI surface
 * lands in PR-2; until then this endpoint can only be exercised via
 * curl with a valid session cookie.
 */
export const POST = withApiHandler({}, async ({ request }) => {
  try {
    let body: { publicDomain?: unknown; dryRun?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const domainError = validatePublicDomain(body.publicDomain);
    if (domainError) {
      return NextResponse.json({ error: domainError }, { status: 400 });
    }
    const publicDomain = (body.publicDomain as string).trim();
    const dryRun = body.dryRun === true;

    const result = await applyMigrationToPublic({ publicDomain, dryRun });
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error, { tag: 'api:system:reverse-proxy:migrate-to-public', status: 500 });
  }
});
