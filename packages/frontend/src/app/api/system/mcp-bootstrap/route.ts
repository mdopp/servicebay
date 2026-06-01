import { NextResponse } from 'next/server';
import { getBootstrapTokenStatus, revokeBootstrapToken, reactivateBootstrapToken } from '@/lib/mcp/bootstrapToken';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * MCP bootstrap token state + manual revoke (#603 migration).
 * GET returns `{ active, expiresAt, minutesRemaining }` — never the
 * hash itself. DELETE is idempotent.
 */
export const GET = withApiHandler({}, async () => {
  const status = await getBootstrapTokenStatus();
  return NextResponse.json(status);
});

export const DELETE = withApiHandler({}, async () => {
  const removed = await revokeBootstrapToken();
  return NextResponse.json({ ok: true, removed });
});

/**
 * POST = re-activate (un-expire) the existing bootstrap token for another
 * ~30 min window (#1419). Same token identity, so an already-configured MCP
 * client reconnects without a fresh mint. Admin-session gated by
 * withApiHandler; the token itself stays LAN-only + read-scope (its verify
 * gate is unchanged). 409 when there's no bootstrap entry to re-activate
 * (revoked after the first named-token mint).
 */
export const POST = withApiHandler({}, async () => {
  const result = await reactivateBootstrapToken();
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 409 });
  }
  const status = await getBootstrapTokenStatus();
  return NextResponse.json({ ok: true, expiresAt: result.expiresAt, minutesRemaining: result.minutesRemaining, status });
});
