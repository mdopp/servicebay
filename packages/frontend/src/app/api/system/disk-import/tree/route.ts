import { NextResponse } from 'next/server';
import { getActiveRun } from '@/lib/diskImport/runStore';
import { buildReviewTree } from '@/lib/diskImport/tree';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { parseReplanBody } from '../replanBody';
import type { Rule, Owner } from '@servicebay/disk-import-worker';

export const dynamic = 'force-dynamic';

/** Build the review-tree opts from a (possibly absent) re-plan request body. */
function treeOpts(req?: { explicit: Record<string, Rule>; rootDefault?: Partial<Rule> }) {
  if (!req) return {};
  return {
    explicit: new Map<string, Rule>(Object.entries(req.explicit ?? {})),
    diskDefaultOwner: req.rootDefault?.owner as Owner | undefined,
  };
}

/**
 * GET — the per-folder REVIEW TREE for the active disk-import run (#1915/#2000).
 * Derived host-side from the worker's compact `plan.json` (no re-scan): one node
 * per folder with file/byte/category rollups, the auto-assigned owner (top-level
 * folder == box user), the resolved effective rule, a live `data/<owner>/<cat>/…`
 * preview, plus the owner + disposition picker options. `404` until a scan has
 * produced a plan.
 */
export const GET = withApiHandler(
  { tokenScope: 'mutate' },
  async () => buildTreeResponse(),
);

/**
 * POST — recompute the review tree with the page's IN-PROGRESS routing edits
 * (#2000) so resolved rules + the live target preview reflect the operator's picks
 * without a re-plan/apply. Body is the same `{ rules, rootDefault }` the apply
 * route takes. Cheap + host-side (no hashing, no worker round-trip) — just a
 * re-resolution of the existing tree.
 */
export const POST = withApiHandler(
  { tokenScope: 'mutate' },
  async ({ request }) => buildTreeResponse(await parseReplanBody(request)),
);

async function buildTreeResponse(
  req?: { explicit: Record<string, Rule>; rootDefault?: Partial<Rule> },
): Promise<NextResponse> {
  try {
    const run = await getActiveRun();
    if (!run) {
      return NextResponse.json({ ok: false, error: 'no active run' }, { status: 404 });
    }
    const review = await buildReviewTree(run.runId, treeOpts(req));
    return NextResponse.json({ ok: true, ...review });
  } catch (e) {
    return apiError(e, { tag: 'api:system:disk-import:tree', status: 400, exposeMessage: true });
  }
}
