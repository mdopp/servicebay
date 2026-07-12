import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandlerParams } from '@/lib/api/handler';
import { submitApproval } from '@/lib/approvals';
import {
  validateProposal,
  writeProposal,
  safeAssistId,
  ProposalValidationError,
  type AssistProposalPayload,
} from '@/lib/assists/editor';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const Body = z.object({
  content: z.string().min(1),
  message: z.string().min(1),
});

// POST /api/assists/:id/propose — submit an edit proposal (#2221). Validates
// frontmatter + runs the secret scan, then creates a pending approval request
// (reusing the generic approvals queue) and stashes the proposal body keyed by
// the request id. Returns { requestId }. NOT admin-gated — anyone with a
// session may propose; approval is the admin gate.
export const POST = withApiHandlerParams<z.infer<typeof Body>, undefined, { id: string }>(
  { body: Body },
  async ({ body, params }) => {
    const rawId = decodeURIComponent(params.id);
    const id = safeAssistId(rawId);
    if (!id) {
      return NextResponse.json({ error: `invalid assist id: ${rawId}` }, { status: 400 });
    }

    try {
      validateProposal(body.content);
    } catch (error) {
      if (error instanceof ProposalValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    try {
      const payload: AssistProposalPayload = { kind: 'assist-edit', assistId: id, message: body.message };
      const approval = await submitApproval({
        service: 'servicebay',
        title: `Assist edit: ${id}`,
        description: body.message,
        payload,
      });
      await writeProposal(id, approval.id, body.content);
      logger.info('api:assists', `proposed edit for "${id}" -> request ${approval.id}`);
      return NextResponse.json({ requestId: approval.id }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:assists', `propose ${id} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
