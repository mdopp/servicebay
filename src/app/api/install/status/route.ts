import { NextResponse } from 'next/server';
import { getCurrentJob, getJob, readLog } from '@/lib/install/jobStore';
import { apiError } from '@/lib/api/errors';

export const dynamic = 'force-dynamic';

/**
 * Read job state + accumulated logs since a byte offset. Used by the
 * client for two purposes:
 *
 *   1. Initial load on mount — fetches full state and any log lines
 *      the socket connection might have missed before subscribe.
 *   2. Active-install detection — when no jobId is supplied, returns
 *      the most recent active job so a reopened browser tab can attach
 *      without prior knowledge of the jobId.
 *
 * Query params:
 *   - `jobId`     (optional) — specific job to fetch; defaults to the
 *                              currently active job
 *   - `logsSince` (optional) — byte offset; only returns log content
 *                              past this point (incremental fetch)
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const jobId = url.searchParams.get('jobId');
    const sinceBytes = parseInt(url.searchParams.get('logsSince') || '0', 10);

    const job = jobId ? await getJob(jobId) : await getCurrentJob();
    if (!job) return NextResponse.json({ job: null, logs: '', logsOffset: 0 });

    const logs = await readLog(job.id, isNaN(sinceBytes) ? 0 : sinceBytes);
    return NextResponse.json({
      job,
      logs: logs.content,
      logsOffset: logs.nextOffset,
    });
  } catch (error) {
    return apiError(error, { tag: 'api:install:status', status: 500 });
  }
}
