import { NextResponse } from 'next/server';
import { approvePendingApproval, ApprovalExpiredError } from '@/lib/mcp/pendingApprovals';
import { withApiHandlerParams } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * Confirm (approve) a pending destructive MCP tool call (#1766) — the human
 * half of the propose → confirm → execute gate.
 *
 * NOTE: This route is superseded by the server.ts-level intercept (#1766 fix).
 * See the comment in the adjacent route.ts (GET list) for the full explanation
 * of WHY the server.ts intercept is necessary (Turbopack module isolation).
 * server.ts intercepts /api/system/mcp/approve/:id before Next.js sees it,
 * sharing the same in-memory store as the /mcp endpoint.
 *
 * SECURITY (preserved in the server.ts intercept): only session-cookie callers
 * are accepted. Bearer tokens get 401 — the proposing agent cannot self-approve.
 *
 * This file is kept as dead code (never reached in production) so the route
 * tree stays consistent and the unit test (route.test.ts) can still validate
 * the logic in isolation.
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
