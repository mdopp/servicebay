import { NextResponse } from 'next/server';
import { getBootstrapTokenStatus, revokeBootstrapToken } from '@/lib/mcp/bootstrapToken';
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
