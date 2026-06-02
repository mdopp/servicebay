import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { buildInstallPlan } from '@/lib/install/installPlan';

export const dynamic = 'force-dynamic';

/**
 * POST /api/install/plan (#1520) — the single source of truth for the
 * desired-state install diff.
 *
 * Given the stacks the operator wants installed (`desired`) and which
 * installed ones to redeploy (`reinstall`), the box returns the resolved
 * plan — `{ install, reinstall, uninstall, blocked, templatesToDeploy,
 * noop }` — computed from the catalog + live twin health. Both the HTML
 * wizard and the `sb` CLI render this instead of each re-deriving the
 * rules, so they can't drift.
 *
 * Read-only (it only inspects state): `tokenScope: 'read'`, matching the
 * stack-catalog endpoint. The actual apply still goes through
 * `/api/install/assemble` + `/start` (deploy) and the per-stack wipe
 * endpoint (uninstall), each with their own scope.
 */
export const POST = withApiHandler({ tokenScope: 'read' }, async ({ request }) => {
  try {
    const body = (await request.json()) as {
      desired?: unknown;
      reinstall?: unknown;
      node?: unknown;
    };
    const desired = Array.isArray(body.desired) ? body.desired.filter((s): s is string => typeof s === 'string') : null;
    if (!desired) {
      return NextResponse.json({ error: 'desired must be an array of stack names' }, { status: 400 });
    }
    const reinstall = Array.isArray(body.reinstall)
      ? body.reinstall.filter((s): s is string => typeof s === 'string')
      : [];
    const node = typeof body.node === 'string' && body.node ? body.node : undefined;
    const plan = await buildInstallPlan(desired, reinstall, node);
    return NextResponse.json(plan);
  } catch (error) {
    return apiError(error, { tag: 'api:install:plan', status: 500 });
  }
});
