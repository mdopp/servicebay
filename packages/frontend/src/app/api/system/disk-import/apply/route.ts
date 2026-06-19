import { NextResponse } from 'next/server';
import { startApplyFlow } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { makeExec, resolveNode, SHARE_GID } from '../wiring';
import { parseReplanBody } from '../replanBody';

export const dynamic = 'force-dynamic';

/**
 * POST — APPLY the active run's approved plan ON THE HOST (#1972). The worker only
 * scanned/planned (it's sandboxed); servicebay reads the worker's plan.json +
 * catalog from the out dir and runs the privileged host apply (mkdir/rsync/chown
 * over the still-mounted device) with its real agent exec, then provisions +
 * scans the owning Immich External Libraries for any photos written. The byte
 * copy is the rsync subprocess (streams) and mkdir/chown are batched, so the
 * control-plane heap stays bounded. Status.json reflects apply progress for the
 * tile poll.
 *
 * When the body carries the page's per-folder routing rules (#2000), servicebay
 * RE-PLANS with them first (re-routes/re-dedups per owner in the worker, over the
 * live mount) so files land in `data/<owner>/<category>/…` — then applies the
 * rewritten plan.json unchanged. An empty/absent body applies the auto-sorted plan.
 *
 * #2009: this returns PROMPTLY. The (multi-minute) re-plan + host-apply run in the
 * background — `startApplyFlow` launches the detached re-plan synchronously then
 * fires the apply, and the page polls status.json to completion. The route no longer
 * blocks for the whole copy (which risked NPM/Authelia/browser timeouts on a big
 * disk); the applied count + Immich note land in status.json, not the response.
 */
export const POST = withApiHandler(
  { tokenScope: 'mutate' },
  async ({ request }) => {
    try {
      const node = resolveNode();
      const replanReq = await parseReplanBody(request);
      await startApplyFlow(makeExec(node), SHARE_GID, replanReq);
      return NextResponse.json({ ok: true });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:apply', status: 400, exposeMessage: true });
    }
  },
);
