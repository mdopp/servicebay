import { NextResponse } from 'next/server';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { listApprovals } from '@/lib/approvals';

export const dynamic = 'force-dynamic';

/**
 * GET /napi/approvals — pending-approval feed for the companion app (#2252).
 *
 * Reuses the SAME `listApprovals()` store as `GET /api/approvals` (no second
 * store, no duplicated logic) and filters to `pending` — the app only renders
 * outstanding approval cards. The `/api/approvals` route stays the browser
 * surface (cookie + read-scoped Bearer); this `/napi/*` twin exists so the app
 * has a proxy-bypassed, token-only path that never touches Authelia.
 *
 * TOKEN-ONLY, read-scoped. `tokenScope: 'read'` in the withApiHandler OPTIONS
 * (#2249) — accepted for a valid read Bearer, 401 for missing/wrong scope.
 */
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    const approvals = (await listApprovals()).filter(a => a.status === 'pending');
    return NextResponse.json({ approvals });
  } catch (e) {
    return apiError(e, { tag: 'napi:approvals', status: 500 });
  }
});
