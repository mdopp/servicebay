import { NextResponse } from 'next/server';
import { getBootstrapTokenStatus, revokeBootstrapToken, reactivateBootstrapToken } from '@/lib/mcp/bootstrapToken';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * MCP bootstrap token state + manual revoke (#603 migration).
 * GET returns `{ active, expiresAt, minutesRemaining }` — never the
 * hash itself. DELETE is idempotent.
 */
// GET carries no scope hold on purpose: it returns only `{ active, expiresAt,
// minutesRemaining }` — never the hash — and the onboarding wizard reads it
// before any session exists. Nothing to enumerate, nothing to escalate.
export const GET = withApiHandler({}, async () => {
  const status = await getBootstrapTokenStatus();
  return NextResponse.json(status);
});

// Deactivating the reconnect bridge is a credential revoke — `destroy`, like the
// named-token DELETE (#2944).
export const DELETE = withApiHandler({ cookieScope: 'destroy' }, async () => {
  const removed = await revokeBootstrapToken();
  return NextResponse.json({ ok: true, removed });
});

/**
 * POST = re-activate (un-expire) the existing bootstrap token for another
 * ~30 min window (#1419). Same token identity, so an already-configured MCP
 * client reconnects without a fresh mint. Re-opening a credential's window is
 * the same act as minting one, so it is held to `mutate` (#2944) — a `read`-only
 * bridged session may not re-arm the bridge. The token itself stays LAN-only +
 * read-scope (its verify gate is unchanged). 409 when there's no bootstrap entry
 * to re-activate (revoked after the first named-token mint).
 */
export const POST = withApiHandler({ cookieScope: 'mutate' }, async () => {
  const result = await reactivateBootstrapToken();
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 409 });
  }
  const status = await getBootstrapTokenStatus();
  return NextResponse.json({ ok: true, expiresAt: result.expiresAt, minutesRemaining: result.minutesRemaining, status });
});
