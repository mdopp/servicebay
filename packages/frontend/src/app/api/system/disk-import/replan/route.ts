import { NextResponse } from 'next/server';
import { replanRun } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { makeExec, resolveNode } from '../wiring';
import { parseReplanBody } from '../replanBody';

export const dynamic = 'force-dynamic';

/**
 * POST — RE-PLAN the active run with the page's per-folder routing rules WITHOUT
 * applying (#2000). servicebay writes the rules to the shared out dir and
 * `podman exec`s the running worker to re-route + re-dedup PER OWNER over the live
 * mount (only the worker can hash — #1983), rewriting plan.json + status.json. The
 * tile's status poll then shows the owner-aware plan (new per-category counts +
 * the dropped conflict total) for review before "Import now" applies it.
 */
export const POST = withApiHandler(
  { tokenScope: 'mutate' },
  async ({ request }) => {
    try {
      const req = await parseReplanBody(request);
      if (!req) {
        return NextResponse.json({ ok: false, error: 'no routing rules to re-plan' }, { status: 400 });
      }
      const node = resolveNode();
      await replanRun(makeExec(node), req);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:replan', status: 400, exposeMessage: true });
    }
  },
);
