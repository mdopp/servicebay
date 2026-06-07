import { NextResponse } from 'next/server';
import { approvePendingApproval, ApprovalExpiredError } from '@/lib/mcp/pendingApprovals';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Confirm (approve) a pending destructive MCP tool call (#1766) — the human
 * half of the propose → confirm → execute gate.
 *
 * SECURITY (the whole point of the feature): this route deliberately carries
 * NO `tokenScope`. A POST is a mutating verb, so withApiHandler runs the
 * requireSession gate; with no `tokenScope` set, requireSession *ignores* any
 * `Authorization: Bearer sb_…` and 401s a token caller (see
 * packages/backend/src/lib/api/requireSession.ts). Only a valid session
 * **cookie** (a logged-in human) is accepted. The agent that proposed the
 * call holds a token, so it can never self-approve its own request.
 *
 * On success the stored call executes through the same safety path
 * (snapshot → handler → audit/notify) it would have run inline, and the tool
 * result is returned. Single-use: the pending entry is claimed before it runs,
 * so it can't be confirmed twice. An expired/unknown id returns 410 Gone.
 */
export const POST = withApiHandlerParams<undefined, undefined, { pendingId: string }>(
  {},
  async ({ params }) => {
    try {
      const result = await approvePendingApproval(params.pendingId);
      return NextResponse.json({ ok: true, result });
    } catch (e) {
      if (e instanceof ApprovalExpiredError) {
        return NextResponse.json(
          { ok: false, error: 'This approval has expired or was already used. Ask the agent to propose the action again.' },
          { status: 410 },
        );
      }
      throw e;
    }
  },
);
