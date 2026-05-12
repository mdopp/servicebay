import { NextResponse } from 'next/server';
import { createJob, getCurrentJob, type JobInput } from '@/lib/install/jobStore';
import { startJob } from '@/lib/install/runner';
import { apiError } from '@/lib/api/errors';

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
 */
export async function POST(request: Request) {
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
    const job = await createJob({ source: body.source ?? 'wizard', input });
    startJob(job.id);
    return NextResponse.json({ jobId: job.id });
  } catch (error) {
    return apiError(error, { tag: 'api:install:start', status: 500 });
  }
}
