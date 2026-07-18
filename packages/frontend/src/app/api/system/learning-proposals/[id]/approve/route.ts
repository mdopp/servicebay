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
 * LANDING (#2326 s4): approving now ALSO lands the assist. `approveProposal`
 * runs the HARD secret-scan and, on a clean scan, writes the assist to
 * `DATA_DIR/local-assists/<slug>.md` (final status `landed`, served as
 * `local/<slug>`). If the content matches a secret signature the landing is
 * REFUSED — nothing is written and the final status is `blocked` with a
 * `landingError` reason. Either way the response reports the final status so
 * the admin sees whether it landed or was blocked.
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
      ...(outcome.proposal.landingError ? { landingError: outcome.proposal.landingError } : {}),
      ...(outcome.proposal.landedFile ? { landedFile: outcome.proposal.landedFile } : {}),
    });
  },
);
