import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getImportJob } from '@/lib/diskImport/service';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

const Query = z.object({
  /** The job id returned by `scan` / `apply`. */
  id: z.string().min(1),
});

/**
 * GET — poll a disk-import job by id (#1897). The card hangs off this between
 * the immediate `scan`/`apply` hand-off and the result:
 *
 *   - while `scanning`/`applying`: live phase (`progress.step`) + counts
 *     (scanned / hashed / copied / bytes) so the card shows real progress, not
 *     a bare spinner;
 *   - once `reviewed`: the `review` payload (per-category sizing + non-blocking
 *     actions[]) — a reopened card re-attaches to the finished scan by id;
 *   - once `applied`: the final `applied` count;
 *   - `error`: the failure message.
 *
 * Read-only; the session store is durable (#1896) so this survives a backend
 * restart — a reopened card re-attaches to an in-flight or finished job.
 * `404` when the id is unknown/forged/pruned.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query, tokenScope: 'mutate' },
  async ({ query }) => {
    try {
      const status = await getImportJob(query.id);
      if (!status) {
        return NextResponse.json({ ok: false, error: 'unknown job' }, { status: 404 });
      }
      return NextResponse.json({ ok: true, ...status });
    } catch (e) {
      return apiError(e, { tag: 'api:system:disk-import:status', status: 400, exposeMessage: true });
    }
  },
);
