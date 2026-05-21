import { NextResponse } from 'next/server';
import { z } from 'zod';
import { abortJob } from '@/lib/install/runner';
import { apiError } from '@/lib/api/errors';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

const Body = z.object({ jobId: z.string().min(1) });

/**
 * Abort a running install. Sets the in-memory abort flag the runner
 * checks between deploy iterations and unblocks any pending NPM
 * credentials prompt. The deploy loop transitions the job's phase to
 * `aborted` cleanly. Idempotent — calling on an already-aborted job
 * is a no-op.
 */
export const POST = withApiHandler<z.infer<typeof Body>>(
  { body: Body },
  async ({ body }) => {
    try {
      abortJob(body.jobId);
      return NextResponse.json({ ok: true });
    } catch (error) {
      return apiError(error, { tag: 'api:install:abort', status: 500 });
    }
  },
);
