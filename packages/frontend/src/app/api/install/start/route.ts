import { NextResponse } from 'next/server';
import { createJob, getCurrentJob, InstallInProgressError, type JobInput } from '@/lib/install/jobStore';
import { startJob } from '@/lib/install/runner';
import { apiError } from '@/lib/api/errors';

import { withApiHandler } from '@/lib/api/handler';
export const dynamic = 'force-dynamic';

/**
 * Kick off a server-side install job. Body shape mirrors the
 * `useStackInstall.runInstall` arguments — items + variables already
 * resolved client-side in the configure step. Server takes ownership
 * of the deploy loop from here.
 *
 * Idempotency: refuses to start a second job if one is already in an
 * active phase (running / needs_credentials). The wizard surfaces this
 * via the `installInProgress` banner + reattach flow.
 *
 * Two layers of serialization: the pre-check below is a fast path for
 * the common case (already-running install observed via the
 * `installInProgress` banner). The authoritative gate is inside
 * `createJob` (#1100), which holds an in-process lock across the
 * active-job re-check and the state-file write — without that lock,
 * two parallel POSTs could both pass this pre-check and start
 * simultaneous installs racing on shared host state.
 *
 * `tokenScope: 'lifecycle'` (#1276) lets the sb-tui stack-install panel start
 * an install with a scoped `sb_` token. Progress is then polled on the public
 * jobId-gated `/api/install/progress` (no token needed there).
 */
export const POST = withApiHandler({ tokenScope: 'lifecycle' }, async ({ request }) => {
  try {
    const body = (await request.json()) as { source?: string; input?: JobInput };
    const input = body.input;
    if (!input || !Array.isArray(input.items) || !Array.isArray(input.variables)) {
      return NextResponse.json({ error: 'invalid input' }, { status: 400 });
    }
    const existing = await getCurrentJob();
    if (existing) {
      return NextResponse.json(
        { error: 'install already in progress', jobId: existing.id },
        { status: 409 },
      );
    }
    try {
      const job = await createJob({ source: body.source ?? 'wizard', input });
      startJob(job.id);
      return NextResponse.json({ jobId: job.id });
    } catch (e) {
      if (e instanceof InstallInProgressError) {
        return NextResponse.json(
          { error: 'install already in progress', jobId: e.existingJobId },
          { status: 409 },
        );
      }
      throw e;
    }
  } catch (error) {
    return apiError(error, { tag: 'api:install:start', status: 500 });
  }
});
