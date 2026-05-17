import { NextResponse } from 'next/server';
import { abortJob } from '@/lib/install/runner';
import { apiError } from '@/lib/api/errors';

import { requireSession } from '@/lib/api/requireSession';
export const dynamic = 'force-dynamic';

/**
 * Abort a running install. Sets the in-memory abort flag the runner
 * checks between deploy iterations and unblocks any pending NPM
 * credentials prompt. The deploy loop transitions the job's phase to
 * `aborted` cleanly. Idempotent — calling on an already-aborted job
 * is a no-op.
 */
export async function POST(request: Request) {
  // requireSession gate (#596) — defense-in-depth atop proxy.ts.
  const __auth = await requireSession(request);
  if (__auth instanceof NextResponse) return __auth;

  try {
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: 'jobId required' }, { status: 400 });
    }
    abortJob(body.jobId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, { tag: 'api:install:abort', status: 500 });
  }
}
