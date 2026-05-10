import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import {
  getBootstrapTokenStatus,
  revokeBootstrapToken,
} from '@/lib/mcp/bootstrapToken';

export const dynamic = 'force-dynamic';

/** Surface bootstrap-token state for the Settings UI. The actual hash
 *  is never returned — only `active`, `expiresAt`, `minutesRemaining`. */
export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const status = await getBootstrapTokenStatus();
    return NextResponse.json(status);
  } catch (e) {
    return apiError(e, { tag: 'api:system:mcp-bootstrap:get', status: 500 });
  }
}

/** Manual revoke. Idempotent — returns 200 either way so the UI
 *  doesn't have to special-case "already gone". */
export async function DELETE(request: Request) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const removed = await revokeBootstrapToken();
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    return apiError(e, { tag: 'api:system:mcp-bootstrap:delete', status: 500 });
  }
}
