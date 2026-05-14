import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { syncSambaWithLldap } from '@/lib/fileShare/sambaSync';

export const dynamic = 'force-dynamic';

/**
 * GET  /api/system/file-share/samba/users
 *  Returns the LLDAP user list with each user's Samba sync state.
 *  Side-effect: missing tdbsam entries get added (with a random
 *  initial password); orphan tdbsam entries get removed. The route
 *  IS the sync — calling it idempotently from the UI keeps things in
 *  step without a separate "Run sync" button.
 *
 * POST /api/system/file-share/samba/users
 *  Manually trigger the same sync. Same response shape. Exists so
 *  the operator can force a refresh from the UI after creating a new
 *  LLDAP user (LLDAP's user-create flow runs in a separate pod and
 *  has no broadcast hook).
 */
export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}

async function handle(request: NextRequest) {
  try {
    const auth = await requireSession(request);
    if (auth instanceof NextResponse) return auth;
    const result = await syncSambaWithLldap();
    if (!result.ok) {
      const status = result.reason === 'samba_unavailable' ? 404
        : result.reason === 'lldap_unavailable' ? 503
        : 500;
      return NextResponse.json({ error: result.message, reason: result.reason }, { status });
    }
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error, { tag: 'api:system:file-share:samba:users', status: 500 });
  }
}
