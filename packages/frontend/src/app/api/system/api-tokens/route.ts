import { withApiHandler } from '@/lib/api/handler';
import {
  getTokensHandler,
  createTokenHandler,
  deleteTokenHandler,
  DeleteTokenQuery,
} from '@/lib/api/apiTokenRoutes';
import type { z } from 'zod';

// Canonical home for named API tokens (#1264). These tokens authenticate
// both the MCP server and (opt-in) REST routes, so the store + route live
// under a neutral name rather than `mcp-tokens`. The old `/api/system/
// mcp-tokens` path wraps the same handlers for back-compat.
export const dynamic = 'force-dynamic';

export const GET = withApiHandler({}, getTokensHandler);
export const POST = withApiHandler({}, createTokenHandler);
export const DELETE = withApiHandler<undefined, z.infer<typeof DeleteTokenQuery>>(
  { query: DeleteTokenQuery },
  deleteTokenHandler,
);
