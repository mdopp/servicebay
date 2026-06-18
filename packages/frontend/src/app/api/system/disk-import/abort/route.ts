import { NextResponse } from 'next/server';
import { abortRun } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { makeExec, resolveNode } from '../wiring';

export const dynamic = 'force-dynamic';

/**
 * POST — stop the active disk-import worker container and forget the run (#1949).
 * The tile's "Start over": `podman rm -f` the worker (an OOM/kill of it never
 * touched the control plane) and clear the run handle so a fresh scan can start.
 * Idempotent — a no-op when there's no active run.
 */
export const POST = withApiHandler(
  { tokenScope: 'mutate' },
  async () => {
    try {
      await abortRun(makeExec(resolveNode()));
      return NextResponse.json({ ok: true });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:abort', status: 400, exposeMessage: true });
    }
  },
);
