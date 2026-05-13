import { NextResponse } from 'next/server';
import { getCurrentJob, getJob, getLatestJob, readLog } from '@/lib/install/jobStore';
import { getConfig } from '@/lib/config';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

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
 *     logs / logsOffset
 *   }
 *
 * Both Sidebar (Setup pill visibility) and OnboardingWizard (auto-open
 * suppression) hang off this one endpoint. Returning the latest *any*
 * job instead of only active ones closes the UX gap where the wizard
 * pops back open on every reload after install finishes but the
 * operator hasn't acknowledged the result yet.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get('jobId');
    const sinceBytes = parseInt(url.searchParams.get('logsSince') || '0', 10);

    let job = jobId ? await getJob(jobId) : await getCurrentJob();
    const jobIsActive = !!job; // getCurrentJob only returns active phases
    if (!job && !jobId) {
      // Fall through to the most-recent job so /setup + Sidebar can
      // still show the "click Finish" state after the operator
      // minimised the wizard.
      job = await getLatestJob();
    }

    const config = await getConfig();
    const stackSetupPending = config.stackSetupPending === true;

    if (!job) {
      return NextResponse.json({
        job: null,
        jobIsActive: false,
        stackSetupPending,
        logs: '',
        logsOffset: 0,
      });
    }

    const logs = await readLog(job.id, isNaN(sinceBytes) ? 0 : sinceBytes);
    return NextResponse.json({
      job,
      jobIsActive,
      stackSetupPending,
      logs: logs.content,
      logsOffset: logs.nextOffset,
    });
  } catch (error) {
    return apiError(error, { tag: 'api:install:status', status: 500 });
  }
}
