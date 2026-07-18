import { NextResponse } from 'next/server';
import { approveProposal } from '@/lib/assists/proposals';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Admin approval for a learning proposal (#2326 slice 3).
 *
 * Mirrors the access-request approve/deny surface (see
 * `../../access-requests/[id]/approve` and `.../[id]/route.ts`): an
 * admin-only route that flips the proposal's `status` — here from `pending`
 * to `approved` — and stamps `resolvedAt` / `resolvedBy`. This is the SAME
 * approval mechanism the access-request queue uses; there is no second
 * approval system.
 *
 * Authority: the route requires a session (POST → the handler's built-in
 * requireSession gate; withApiHandlerParams re-validates per #596). A
 * `propose`-scoped MCP submitter has no session and no MCP approve tool, so
 * it can never approve its own proposal.
 *
 * SLICE BOUNDARY (s3 → s4): approving ONLY records the decision. `approved`
 * is decided-but-NOT-landed — no `.md` is written to
 * `DATA_DIR/local-assists/` and the secret-scan has NOT run. Slice 4 hooks
 * the `approved` state to run the secret-scan and land the file.
 */

type Params = { id: string };

export const POST = withApiHandlerParams<undefined, undefined, Params>(
  {},
  async ({ params, auth }) => {
    const outcome = await approveProposal(params.id, auth?.user);
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
