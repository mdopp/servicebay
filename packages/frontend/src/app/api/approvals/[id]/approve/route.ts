import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { approveApproval, getApproval, isSelfApproval } from '@/lib/approvals';
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

// tokenScope:'mutate' (#2244) — a scoped Bearer token holding `mutate` may
// deliver the operator's verdict (approve). NOT `destroy`: the verdict itself
// is a mutate-tier action; the destructive work an on_approve.mcp action runs
// was already scope-checked when the agent PROPOSED it. Cookie sessions work
// unchanged. Self-approve guard below preserves the human-in-the-loop invariant
// (a token cannot approve the very request it proposed).
export const POST = withApiHandlerParams<undefined, undefined, { id: string }>(
  { tokenScope: 'mutate' },
  async ({ params, auth }) => {
    const id = decodeURIComponent(params.id);
    // A token holding `mutate` may act as a verdict-delivery consumer, but it
    // must never approve the destructive proposal IT itself submitted — that
    // would let an agent self-authorize (memory
    // reference_mcp_destroy_tier_approval_flow). The cookie operator path never
    // trips this (its identity is not the recorded token proposer).
    const existing = await getApproval(id);
    if (existing && isSelfApproval(existing, auth?.user)) {
      return NextResponse.json(
        { error: 'A token cannot approve the request it proposed; a ServiceBay admin must approve it.' },
        { status: 403 },
      );
    }
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
