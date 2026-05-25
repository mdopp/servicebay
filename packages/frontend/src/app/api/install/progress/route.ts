import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getJob, readLog } from '@/lib/install/jobStore';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({
  jobId: z.string().optional(),
  logsSince: z.string().optional(),
});

/**
 * Public, sanitized view of an install job's progress (#663 — S1).
 *
 * Sibling of `/api/install/status` which carries the full job state
 * (including `input.variables` — i.e. operator-supplied passwords and
 * other secrets). This endpoint exists for one specific case:
 *
 *   During a clean install with `secrets` wiped, the runner deletes
 *   `.auth-secret.env`. AUTH_SECRET is regenerated on the next request
 *   that needs it (self-heal). The operator's session cookie was
 *   signed with the *old* AUTH_SECRET — it becomes invalid the moment
 *   the rotation happens. Every poll on `/api/install/status` then
 *   401s, the wizard's overlay silently stops updating, and the
 *   operator sees nothing while the install actually keeps running.
 *
 * The wizard already has the `jobId` in memory (it created the job
 * via `/api/install/start`). Knowing a jobId is sufficient auth here
 * because:
 *   - jobIds are uuidv4 (122 bits of entropy) — not guessable
 *   - this endpoint is GET-only, read-only
 *   - no operator-supplied secrets, no credentials manifest
 *   - log lines are install-runner text (e.g. "🔑 Reusing 7 saved
 *     secrets" — names, not values)
 *
 * The dual `/status` (cookie-gated, full data) and `/progress`
 * (jobId-gated, sanitised) split is the minimum-blast-radius fix.
 * Re-broadening `/status` to allow jobId-only auth would expose
 * variables; widening `/progress` to include them would defeat the
 * purpose. See `src/proxy.ts:PUBLIC_API_RULES` for the gate config.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query },
  async ({ query }) => {
  try {
    const jobId = query.jobId;
    if (!jobId) {
      return NextResponse.json({ error: 'jobId query parameter required' }, { status: 400 });
    }
    const sinceBytes = parseInt(query.logsSince || '0', 10);

    const job = await getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: 'job not found' }, { status: 404 });
    }

    const logs = await readLog(job.id, isNaN(sinceBytes) ? 0 : sinceBytes);

    return NextResponse.json({
      job: {
        id: job.id,
        phase: job.phase,
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        endedAt: job.endedAt,
        progress: job.progress,
        error: job.error,
        // Boolean only — the actual fallback creds live in /status
        // (cookie-gated) since they'd let an unauthenticated reader
        // see the NPM admin password ServiceBay generated.
        needsCredentials: !!job.needsCredentials,
      },
      jobIsActive: job.phase === 'running' || job.phase === 'needs_credentials',
      logs: logs.content,
      logsOffset: logs.nextOffset,
    });
  } catch (error) {
    return apiError(error, { tag: 'api:install:progress', status: 500 });
  }
});
