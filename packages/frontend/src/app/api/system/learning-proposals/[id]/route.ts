import { NextResponse } from 'next/server';
import { rejectProposal } from '@/lib/assists/proposals';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Per-proposal admin action for the learning-proposal review queue
 * (#2326 slice 3).
 *
 *   PATCH — reject a pending proposal (admin declined). Flips `status` to
 *           `rejected` and stamps `resolvedAt` / `resolvedBy`. Nothing lands.
 *           The approve path lives in the sibling `approve/route.ts`.
 *
 * Mirrors the access-request per-request route (`../access-requests/[id]`):
 * the deny path is a PATCH that flips the status. Admin-only — POST/PATCH
 * go through the handler's requireSession gate; a `propose`-scoped MCP
 * submitter has no session and no MCP reject tool.
 */

type Params = { id: string };

export const PATCH = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params, auth }) => {
    const outcome = await rejectProposal(params.id, auth?.user);
    if (outcome.result === 'not-found') {
      return NextResponse.json({ error: 'Proposal not found.' }, { status: 404 });
    }
    if (outcome.result === 'not-pending') {
      return NextResponse.json(
        { error: `Proposal is not pending (status: ${outcome.proposal.status}).` },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      id: outcome.proposal.id,
      status: outcome.proposal.status,
    });
  },
);
