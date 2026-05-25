import { NextResponse } from 'next/server';
import { provideCredentials } from '@/lib/install/runner';
import { apiError } from '@/lib/api/errors';

import { withApiHandler } from '@/lib/api/handler';
export const dynamic = 'force-dynamic';

/**
 * Resume a paused install with operator-supplied NPM admin credentials.
 * The runner is awaiting an in-memory promise keyed by `jobId`; this
 * endpoint resolves it with the supplied creds. The runner saves them
 * to `config.reverseProxy.npm` and lets the nginx capability handler
 * pick them up on the next emit.
 */
export const POST = withApiHandler({}, async ({ request }) => {
  try {
    const body = (await request.json()) as {
      jobId?: string;
      email?: string;
      password?: string;
    };
    if (!body.jobId || !body.email || !body.password) {
      return NextResponse.json(
        { error: 'jobId, email, and password are required' },
        { status: 400 },
      );
    }
    const ok = provideCredentials(body.jobId, { email: body.email, password: body.password });
    if (!ok) {
      return NextResponse.json(
        { error: 'no job is currently waiting for credentials' },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, { tag: 'api:install:credentials', status: 500 });
  }
});
