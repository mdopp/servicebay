import { NextResponse } from 'next/server';
import { skipCredentials } from '@/lib/install/runner';
import { apiError } from '@/lib/api/errors';

import { requireSession } from '@/lib/api/requireSession';
export const dynamic = 'force-dynamic';

/**
 * Resume a paused install by skipping the NPM credentials prompt.
 * Proxy routes won't be configured in this run; the operator can fix
 * this later via Settings → Integrations.
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
}
