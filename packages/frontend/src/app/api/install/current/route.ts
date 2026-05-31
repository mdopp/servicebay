import { NextResponse } from 'next/server';
import { getCurrentJob } from '@/lib/install/jobStore';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Token-readable, sanitized summary of the *currently active* install job
 * (running / needs_credentials), or `{ job: null }` when none is active.
 *
 * This exists so the sb-tui launcher can show "install in progress" on a
 * reachable box and offer to reattach to it — without knowing the jobId up
 * front (a fresh launch has no job in memory).
 *
 * Why a new route rather than `/api/install/status`: `/status` returns the
 * full job, including `input.variables` (operator-supplied passwords), so it
 * is deliberately cookie-only. This endpoint returns ONLY non-secret progress
 * fields (id, phase, currentItem, counts) — the same sanitisation `/progress`
 * uses — so it is safe to expose to a scoped `read` token. The returned `id`
 * is then used with the public jobId-gated `/api/install/progress` for logs.
 */
export const GET = withApiHandler({ tokenScope: 'read' }, async () => {
  try {
    const job = await getCurrentJob();
    if (!job) {
      return NextResponse.json({ job: null, jobIsActive: false });
    }
    return NextResponse.json({
      job: {
        id: job.id,
        phase: job.phase,
        progress: {
          currentItem: job.progress.currentItem,
          deployedNames: job.progress.deployedNames,
          totalCount: job.progress.totalCount,
        },
      },
      jobIsActive: job.phase === 'running' || job.phase === 'needs_credentials',
    });
  } catch (error) {
    return apiError(error, { tag: 'api:install:current', status: 500 });
  }
});
