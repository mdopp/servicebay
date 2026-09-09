import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { getInstallRequestState, InstallRequestError } from '@/lib/install/installRequests';

export const dynamic = 'force-dynamic';

/**
 * GET /api/install/requests/[id] (#2965) — what really happened to a request.
 *
 * Bound to the principal that filed it: a different principal gets a 403, so a
 * second agent can neither redeem nor observe someone else's request. The
 * answer never dresses waiting up as success — `installed` is true only once
 * the approved plan has actually run, and `detail` says so in words.
 */
export const GET = withApiHandlerParams<undefined, undefined, { id: string }>(
  { tokenScope: 'propose' },
  async ({ params, auth }) => {
    const principal = auth?.user;
    if (!principal) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }
    try {
      const state = await getInstallRequestState(decodeURIComponent(params.id), principal);
      return NextResponse.json({
        id: state.id,
        status: state.status,
        installed: state.installed,
        detail: state.detail,
        jobId: state.jobId ?? null,
        error: state.error ?? null,
      });
    } catch (error) {
      if (error instanceof InstallRequestError) {
        return NextResponse.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  },
);
