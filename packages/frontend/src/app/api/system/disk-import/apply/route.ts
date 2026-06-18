import { NextResponse } from 'next/server';
import { applyRun } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { makeExec, resolveNode, SHARE_GID } from '../wiring';

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
 */
export const POST = withApiHandler(
  { tokenScope: 'mutate' },
  async () => {
    try {
      const node = resolveNode();
      const result = await applyRun(makeExec(node), SHARE_GID);
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:apply', status: 400, exposeMessage: true });
    }
  },
);
