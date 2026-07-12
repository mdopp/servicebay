import { NextResponse } from 'next/server';
import { withApiHandlerParams } from '@/lib/api/handler';
import { submitApproval } from '@/lib/approvals';
import {
  readHistoryVersion,
  writeProposal,
  validateProposal,
  safeAssistId,
  type AssistProposalPayload,
} from '@/lib/assists/editor';
import { requireAssistAdmin } from '../../../adminGate';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// POST /api/assists/:id/revert/:version — admin only (#2221). Creates a NEW
// approval request whose body is the frozen content of history `version` — a
// revert is never a silent rewrite; it goes through the same approve flow.
export const POST = withApiHandlerParams<undefined, undefined, { id: string; version: string }>(
  { tokenScope: 'read' },
  async ({ params, auth }) => {
    const forbidden = requireAssistAdmin(auth);
    if (forbidden) return forbidden;

    const rawId = decodeURIComponent(params.id);
    const id = safeAssistId(rawId);
    const version = Number(decodeURIComponent(params.version));
    if (!id) {
      return NextResponse.json({ error: `invalid assist id: ${rawId}` }, { status: 400 });
    }
    if (!Number.isInteger(version) || version < 1) {
      return NextResponse.json({ error: `invalid version: ${params.version}` }, { status: 400 });
    }

    try {
      const content = await readHistoryVersion(id, version);
      if (content === null) {
        return NextResponse.json({ error: `history version not found: ${id}@${version}` }, { status: 404 });
      }
      // The frozen content was valid when applied, but re-validate defensively.
      validateProposal(content);

      const message = `Revert "${id}" to version ${version}`;
      const payload: AssistProposalPayload = { kind: 'assist-edit', assistId: id, message, revertOf: version };
      const approval = await submitApproval({
        service: 'servicebay',
        title: `Assist revert: ${id} -> v${version}`,
        description: message,
        payload,
      });
      await writeProposal(id, approval.id, content);
      logger.info('api:assists', `revert requested for "${id}" -> v${version} (request ${approval.id})`);
      return NextResponse.json({ requestId: approval.id, revertOf: version }, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('api:assists', `revert ${id}@${version} failed`, error);
      return NextResponse.json({ error: message }, { status: 400 });
    }
  },
);
