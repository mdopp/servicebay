import { NextResponse } from 'next/server';
import { listPendingApprovals } from '@/lib/mcp/pendingApprovals';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * List pending MCP destructive-tool approvals (#1766). A token-authenticated
 * agent can *propose* a destroy-tier tool call; it parks here awaiting a human
 * confirm. The dashboard reads this to show the operator what is waiting.
 *
 * This GET carries no `tokenScope`, so the only Bearer token that would even
 * reach the handler still 401s at requireSession — the list, like the confirm,
 * is cookie-session only. (A GET with no Bearer is gate-skipped, but the proxy
 * is the primary gate for the dashboard origin.)
 */
export const GET = withApiHandler(
  {},
  async () => {
    return NextResponse.json({ pending: listPendingApprovals() });
  },
);
