import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { getApproval, approveApproval } from '@/lib/approvals';
import { applyApproved, safeAssistId, type AssistProposalPayload } from '@/lib/assists/editor';
import { requireAssistAdmin } from '../../../adminGate';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// POST /api/assists/:id/approve/:requestId — admin only (#2221). Applies the
// proposal: writes the body to DATA_DIR/local-assists/:id.md (overriding the
// built-in) and appends a versioned history entry, then marks the approval
// request approved. A valid token authenticates (tokenScope 'read'), then the
// requireAssistAdmin gate 403s a token that lacks admin ('mutate') privilege.
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

      const author = auth?.user ?? 'admin';
      const version = await applyApproved(payload, requestId, author);
      // Mark the generic approval resolved (its on_approve action is empty).
      await approveApproval(requestId);
      logger.info('api:assists', `approved edit for "${id}" -> version ${version}`);
      return NextResponse.json({ ok: true, id, version });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:assists', `approve ${id}/${requestId} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
