import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { rejectApproval, getApproval, isSelfApproval } from '@/lib/approvals';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// tokenScope:'mutate' (#2244) — a scoped Bearer token holding `mutate` may
// deliver the operator's verdict (reject). Cookie sessions work unchanged. The
// self-approve/reject guard preserves the invariant that a token cannot resolve
// the very request it proposed.
export const POST = withApiHandlerParams<undefined, undefined, { id: string }>(
  { tokenScope: 'mutate' },
  async ({ params, auth }) => {
    const id = decodeURIComponent(params.id);
    // Same human-in-the-loop invariant as the approve route: a token cannot
    // resolve (approve OR reject) the proposal it submitted.
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
      logger.error('api:approvals', `reject ${id} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
