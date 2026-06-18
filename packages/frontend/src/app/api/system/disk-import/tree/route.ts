import { NextResponse } from 'next/server';
import { getActiveRun } from '@/lib/diskImport/runStore';
import { buildReviewTree } from '@/lib/diskImport/tree';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * GET — the per-folder REVIEW TREE for the active disk-import run (#1915 / epic
 * #1901). Derived host-side from the worker's compact `plan.json` (no re-scan):
 * one node per folder with file/byte/category rollups, the auto-assigned owner
 * (top-level folder == box user), the resolved effective rule, plus the owner +
 * disposition picker options. The page renders the tree, the user edits owner +
 * disposition per folder, and those edits flow to the apply call to re-plan with
 * routing. `404` until a scan has produced a plan.
 */
export const GET = withApiHandler(
  { tokenScope: 'mutate' },
  async () => {
    try {
      const run = await getActiveRun();
      if (!run) {
        return NextResponse.json({ ok: false, error: 'no active run' }, { status: 404 });
      }
      const review = await buildReviewTree(run.runId);
      return NextResponse.json({ ok: true, ...review });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:tree', status: 400, exposeMessage: true });
    }
  },
);
