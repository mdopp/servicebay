import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentJob, getJob, getLatestJob, PROCESS_STARTED_AT, readLog } from '@/lib/install/jobStore';
import { getConfig } from '@/lib/config';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({
  jobId: z.string().optional(),
  logsSince: z.string().optional(),
});

/**
 * Read job state + accumulated logs since a byte offset.
 *
 *   - `jobId`     (optional) — specific job to fetch.
 *   - `logsSince` (optional) — byte offset; only returns log content
 *                              past this point (incremental fetch).
 *
 * Response shape:
 *   {
 *     job:           <active job, or the most recent job in any phase if no
 *                    active one, or null when no jobs have ever run>
 *     jobIsActive:   <true while phase is running|needs_credentials>
 *     stackSetupPending: <config flag — true while the operator hasn't
 *                    clicked Finish on /setup>
 *     serverStartedAt: <ISO timestamp the current server process booted at;
 *                    lets the wizard tell a job from *this* boot apart from
 *                    one left over on disk after an OS re-install>
 *     logs / logsOffset
 *   }
 *
 * Both Sidebar (Setup pill visibility) and OnboardingWizard (auto-open
 * suppression) hang off this one endpoint. Returning the latest *any*
 * job instead of only active ones closes the UX gap where the wizard
 * pops back open on every reload after install finishes but the
 * operator hasn't acknowledged the result yet.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
  try {
    const jobId = query.jobId;
    const sinceBytes = parseInt(query.logsSince || '0', 10);

    let job = jobId ? await getJob(jobId) : await getCurrentJob();
    if (!job && !jobId) {
      // Fall through to the most-recent job so /setup + Sidebar can
      // still show the "click Finish" state after the operator
      // minimised the wizard.
      job = await getLatestJob();
    }
    // Derive from phase, not existence — querying a specific terminal
    // jobId returns a job in `done`/`error`/`aborted`/`crashed`, which
    // is NOT active. /setup keys its pinning logic off this flag.
    const jobIsActive = !!job && (job.phase === 'running' || job.phase === 'needs_credentials');

    const config = await getConfig();
    const stackSetupPending = config.stackSetupPending === true;

    if (!job) {
      return NextResponse.json({
        job: null,
        jobIsActive: false,
        stackSetupPending,
        serverStartedAt: PROCESS_STARTED_AT,
        logs: '',
        logsOffset: 0,
      });
    }

    const logs = await readLog(job.id, isNaN(sinceBytes) ? 0 : sinceBytes);
    return NextResponse.json({
      job,
      jobIsActive,
      stackSetupPending,
      serverStartedAt: PROCESS_STARTED_AT,
      logs: logs.content,
      logsOffset: logs.nextOffset,
    });
  } catch (error) {
    return apiError(error, { tag: 'api:install:status', status: 500 });
  }
});
