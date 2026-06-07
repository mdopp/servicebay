import { NextResponse } from 'next/server';
import { listPendingApprovals } from '@/lib/mcp/pendingApprovals';
import { withApiHandler } from '@/lib/api/handler';

export const dynamic = 'force-dynamic';

/**
 * List pending MCP destructive-tool approvals (#1766).
 *
 * NOTE: This route is superseded by the server.ts-level intercept that handles
 * /api/system/mcp/approve before Next.js sees it. The intercept is required
 * because Turbopack bundles a SEPARATE copy of the in-memory pendingApprovals
 * store for each compilation unit — the /mcp endpoint and the Next.js API routes
 * each get their own Map, so a proposal in /mcp would be invisible to this route.
 * server.ts intercepts the path first so both the MCP endpoint and the approve
 * routes share the same module-level store (#1766 fix).
 *
 * This file is kept as dead code so the Next.js route tree stays consistent and
 * tools/tests that import the handler directly still compile.
 */
export const GET = withApiHandler(
  {},
  async () => {
    return NextResponse.json({ pending: listPendingApprovals() });
  },
);
