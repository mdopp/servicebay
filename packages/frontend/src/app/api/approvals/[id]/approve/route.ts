import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { approveApproval } from '@/lib/approvals';
// Side-effect import (#2237): loading mcp/server runs its top-level
// registerMcpDispatcher(...) call, so this route's bundle instance of
// lib/approvals HAS a dispatcher when approving an on_approve.mcp approval.
// Without it, Turbopack bundles the App-Router route with its OWN copy of
// lib/approvals — one where the backend server's startup import never ran —
// leaving mcpDispatcher null and the approve failing with HTTP 400 "MCP tool
// dispatcher is not registered" (box-verified RED on #2234). Importing the
// registration seam here makes the single generic /api/approvals approve path
// run the tool, so Settings → Approvals "Approve" works for MCP approvals too.
import '@/lib/mcp/server';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export const POST = withApiHandlerParams<undefined, undefined, { id: string }>(
  {},
  async ({ params }) => {
    const id = decodeURIComponent(params.id);
    try {
      const result = await approveApproval(id);
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:approvals', `approve ${id} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
