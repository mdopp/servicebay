import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { rejectApproval, getApproval, isSelfApproval } from '@/lib/approvals';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * POST /napi/approvals/:id/deny — deliver an operator "deny" verdict from the
 * companion app (#2253, child 3 of epic #2242).
 *
 * The token-only, proxy-bypassed twin of `POST /api/approvals/[id]/reject`
 * (named `deny` on the /napi surface to match the companion-app verb). Reuses
 * the SAME `rejectApproval()` store + `isSelfApproval` guard — no second store.
 * The browser reject route stays cookie + mutate-Bearer; this `/napi/*` twin is
 * the token-only path that never touches Authelia.
 *
 * TOKEN-GATED, `mutate`-scoped. `tokenScope: 'mutate'` in the
 * withApiHandlerParams OPTIONS (#2249 — scope in the wrapper the gate reads).
 * A `read`-only device token (the pairing default, #2251) is rejected.
 *
 * SELF-APPROVE GUARD preserved: a token can never resolve (approve OR deny) the
 * very request it proposed.
 */
export const POST = withApiHandlerParams<undefined, undefined, { id: string }>(
  { tokenScope: 'mutate' },
  async ({ params, auth }) => {
    const id = decodeURIComponent(params.id);
    const existing = await getApproval(id);
    if (existing && isSelfApproval(existing, auth?.user)) {
      return NextResponse.json(
        { error: 'A token cannot resolve the request it proposed; a ServiceBay admin must decide it.' },
        { status: 403 },
      );
    }
    try {
      const result = await rejectApproval(id);
      return NextResponse.json({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('napi:approvals', `deny ${id} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
