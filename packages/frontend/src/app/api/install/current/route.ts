import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentJob, getJob, getLatestJob, readLog } from '@/lib/install/jobStore';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Query = z.object({ jobId: z.string().optional() });

/** Last few log lines of a job, for the "how did it end" half (#3027). */
const LOG_TAIL_LINES = 12;

/**
 * Token-readable, sanitized view of an install job.
 *
 * Why a route separate from `/api/install/status`: `/status` returns the full
 * job, including `input.variables` — operator-supplied passwords — so it is
 * deliberately cookie-only. This one returns only non-secret progress fields
 * (id, phase, currentItem, counts, error, log tail), so a scoped `read` token
 * may have it.
 *
 * ## It also answers "how did the last one end" (#3027)
 *
 * It used to report the CURRENTLY ACTIVE job and nothing else. `servicebay
 * install` hands back a job id, the session polls, the job ends — and the
 * answer became "no install job is running" while the outcome sat on disk:
 *
 *     { "phase": "error",
 *       "error": "Nothing was deployed: 0 of 1 requested service(s) reached the box (flutstunde)." }
 *
 * A good message that reached nobody. The session concluded the template had
 * not been found — guessed right, but guessed — and tried twice more with other
 * `--source` values because it had nothing else. Three attempts for a fact that
 * was on disk the whole time.
 *
 * So: `?jobId=` reads a specific job (the id `install` prints is now redeemable),
 * and with no active job the response carries `last` — the most recent terminal
 * job with its error and log tail. "Nothing is running" is a worse answer than
 * "the last run ended like this".
 *
 * `job` / `jobIsActive` keep their meaning exactly, so the sb launcher's
 * reattach check is untouched.
 */
export const GET = withApiHandler<undefined, z.infer<typeof Query>>(
  { query: Query, tokenScope: 'read' },
  async ({ query }) => {
    try {
      if (query.jobId) {
        const job = await getJob(query.jobId);
        if (!job) {
          return NextResponse.json(
            { error: `No install job with id "${query.jobId}". Ids are printed by \`servicebay install\` and kept for the most recent runs.` },
            { status: 404 },
          );
        }
        return NextResponse.json({ job: await summarize(job), jobIsActive: isActive(job.phase) });
      }

      const active = await getCurrentJob();
      if (active) {
        return NextResponse.json({ job: await summarize(active), jobIsActive: true });
      }

      // Nothing running. Say how the last one ended rather than nothing at all.
      const latest = await getLatestJob();
      return NextResponse.json({
        job: null,
        jobIsActive: false,
        ...(latest ? { last: await summarize(latest) } : {}),
      });
    } catch (error) {
      return apiError(error, { tag: 'api:install:current', status: 500 });
    }
  },
);

function isActive(phase: string): boolean {
  return phase === 'running' || phase === 'needs_credentials';
}

/**
 * Non-secret fields only. `input.variables` carries operator passwords and
 * never leaves this function; the log tail is runner text (names, not values)
 * and gets the same treatment `/api/install/progress` gives it.
 */
async function summarize(job: { id: string; phase: string; startedAt: string; endedAt?: string; error?: string; warnings?: string[]; progress: { currentItem: string | null; deployedNames: string[]; totalCount: number } }) {
  const { content } = await readLog(job.id, 0).catch(() => ({ content: '' }));
  const { redactLogText } = await import('@/lib/mcp/redact');
  const lines = redactLogText(content).split('\n').filter(Boolean);
  return {
    id: job.id,
    phase: job.phase,
    startedAt: job.startedAt,
    endedAt: job.endedAt ?? null,
    progress: {
      currentItem: job.progress.currentItem,
      deployedNames: job.progress.deployedNames,
      totalCount: job.progress.totalCount,
    },
    error: job.error ?? null,
    warnings: job.warnings ?? [],
    logTail: lines.slice(-LOG_TAIL_LINES),
  };
}
