import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { getApproval, rejectApproval } from '@/lib/approvals';
import { discardRejected, safeAssistId, type AssistProposalPayload } from '@/lib/assists/editor';
import { requireAssistAdmin } from '../../../adminGate';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// POST /api/assists/:id/reject/:requestId — admin only (#2221). Discards the
// proposal (removes the pending body, writes NO local file) and marks the
// approval request rejected.
export const POST = withApiHandlerParams<undefined, undefined, { id: string; requestId: string }>(
  { tokenScope: 'read' },
  async ({ params, auth }) => {
    const forbidden = requireAssistAdmin(auth);
    if (forbidden) return forbidden;

    const rawId = decodeURIComponent(params.id);
    const id = safeAssistId(rawId);
    const requestId = decodeURIComponent(params.requestId);
    if (!id) {
      return NextResponse.json({ error: `invalid assist id: ${rawId}` }, { status: 400 });
    }

    try {
      const approval = await getApproval(requestId);
      if (!approval) {
        return NextResponse.json({ error: `approval request not found: ${requestId}` }, { status: 404 });
      }
      const payload = approval.payload as AssistProposalPayload;
      if (payload?.kind !== 'assist-edit' || payload.assistId !== id) {
        return NextResponse.json({ error: 'request does not match this assist' }, { status: 400 });
      }
      if (approval.status !== 'pending') {
        return NextResponse.json({ error: `request already ${approval.status}` }, { status: 409 });
      }

      await discardRejected(payload, requestId);
      await rejectApproval(requestId);
      logger.info('api:assists', `rejected edit for "${id}" (request ${requestId})`);
      return NextResponse.json({ ok: true, id });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:assists', `reject ${id}/${requestId} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
