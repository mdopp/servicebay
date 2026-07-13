import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { approveApproval, getApproval, isSelfApproval } from '@/lib/approvals';
import { resolveDelegatedApprover } from '../../delegatedApprover';
// Side-effect import (#2237): loading mcp/server runs its top-level
// registerMcpDispatcher(...) call, so THIS route's bundle instance of
// lib/approvals has a dispatcher when approving an on_approve.mcp approval.
// Same reason as the browser /api/approvals/[id]/approve route — the App-Router
// route would otherwise bundle its own copy of lib/approvals with a null
// dispatcher and 400 with "MCP tool dispatcher is not registered" (box-verified
// RED on #2234). Import the registration seam here so the /napi verdict path
// runs the tool too.
import '@/lib/mcp/server';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * POST /napi/approvals/:id/approve — deliver an operator "approve" verdict from
 * the companion app (#2253, child 3 of epic #2242).
 *
 * The token-only, proxy-bypassed twin of `POST /api/approvals/[id]/approve`.
 * Reuses the SAME `approveApproval()` store + `isSelfApproval` guard — no second
 * store, no duplicated logic; a phone tap and a browser click resolve the same
 * queue. The browser route stays cookie + mutate-Bearer; this `/napi/*` twin is
 * the token-only path that never touches Authelia.
 *
 * TOKEN-GATED, `mutate`-scoped. `tokenScope: 'mutate'` in the
 * withApiHandlerParams OPTIONS (#2249 — scope in the wrapper the gate reads, not
 * an inner requireSession). NOT `destroy`: delivering the verdict is a
 * mutate-tier action; the destructive work an on_approve.mcp action runs was
 * already scope-checked when the agent PROPOSED it. A `read`-only device token
 * (the pairing default, #2251) is rejected.
 *
 * SELF-APPROVE GUARD preserved (memory reference_mcp_destroy_tier_approval_flow):
 * a token can never approve the very request it proposed — the destructive
 * action must route through a DIFFERENT operator's verdict.
 */
export const POST = withApiHandlerParams<undefined, undefined, { id: string }>(
  { tokenScope: 'mutate' },
  async ({ request, params, auth }) => {
    const id = decodeURIComponent(params.id);

    // Delegated-admin auth mode (#2268, ADR 0010): if the caller carries a valid
    // X-SB-Delegated-Admin assertion, the verdict runs AS that real admin user
    // (audited by the guard). No assertion → fall back to the existing
    // device-token/session path (self-approve guard below). An INVALID assertion
    // → 403, never a silent fall-through.
    const delegated = await resolveDelegatedApprover(request, 'approve', id, auth);
    if (delegated.mode === 'reject') return delegated.response;

    if (delegated.mode === 'fallback') {
      const existing = await getApproval(id);
      if (existing && isSelfApproval(existing, auth?.user)) {
        return NextResponse.json(
          { error: 'A token cannot approve the request it proposed; a ServiceBay admin must approve it.' },
          { status: 403 },
        );
      }
    }
    try {
      const result = await approveApproval(id);
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('napi:approvals', `approve ${id} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
