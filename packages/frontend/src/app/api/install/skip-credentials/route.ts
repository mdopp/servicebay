import { NextResponse } from 'next/server';
import { skipCredentials } from '@/lib/install/runner';
import { apiError } from '@/lib/api/errors';

import { withApiHandler } from '@/lib/api/handler';
export const dynamic = 'force-dynamic';

/**
 * Resume a paused install by skipping the NPM credentials prompt.
 * Proxy routes won't be configured in this run; the operator can fix
 * this later via Settings → Integrations.
 *
 * `tokenScope: 'lifecycle'` lets the sb-tui install panel resolve a
 * needs_credentials pause with its scoped `sb_` token — the same scope
 * that already authorises `/api/install/start`, and strictly less
 * powerful (it only continues an install the operator already started).
 */
export const POST = withApiHandler({ tokenScope: 'lifecycle' }, async ({ request }) => {
  try {
    const body = (await request.json()) as { jobId?: string };
    if (!body.jobId) {
      return NextResponse.json({ error: 'jobId required' }, { status: 400 });
    }
    const ok = skipCredentials(body.jobId);
    if (!ok) {
      return NextResponse.json(
        { error: 'no job is currently waiting for credentials' },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiError(error, { tag: 'api:install:skip-credentials', status: 500 });
  }
});
