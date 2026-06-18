import { NextResponse } from 'next/server';
import { getRunStatus } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { makeExec, resolveNode } from '../wiring';

export const dynamic = 'force-dynamic';

/**
 * GET — the active disk-import worker run's COMPACT status (#1949). Reads only
 * the worker's status.json (step/phase/counts) + `podman ps` liveness — never the
 * heavy 269k-node plan, which the worker app serves itself, lazily. `404` when no
 * scan has been launched. The tile polls this for progress; the lazy review tree
 * is served by the worker app behind its own proxied route.
 */
export const GET = withApiHandler(
  { tokenScope: 'mutate' },
  async () => {
    try {
      const status = await getRunStatus(makeExec(resolveNode()));
      if (!status) {
        return NextResponse.json({ ok: false, error: 'no active run' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, ...status });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:status', status: 400, exposeMessage: true });
    }
  },
);
