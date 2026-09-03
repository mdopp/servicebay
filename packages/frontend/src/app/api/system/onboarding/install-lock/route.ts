import { withApiHandler } from '@/lib/api/handler';
import { getCurrentJob } from '@/lib/install/jobStore';
import { abortJob } from '@/lib/install/runner';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/system/onboarding/install-lock — force-clear a stuck install
 * (#2745, was `app/actions/onboarding.ts:forceClearInstallLock`). Surfaced in
 * the wizard so the operator can recover from a wedged job without restarting
 * the server. Aborts the runner if it is still alive; the job state
 * transitions to `phase=aborted` via the runner's normal cleanup path.
 */
export const DELETE = withApiHandler({}, async () => {
  const job = await getCurrentJob();
  if (job) abortJob(job.id);
  return { success: true as const };
});
