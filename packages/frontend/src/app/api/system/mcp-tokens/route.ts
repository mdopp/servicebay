import { withApiHandler } from '@/lib/api/handler';
import {
  getTokensHandler,
  createTokenHandler,
  deleteTokenHandler,
  DeleteTokenQuery,
} from '@/lib/api/apiTokenRoutes';
import type { z } from 'zod';

// Back-compat alias (#1264). Named API tokens moved to the neutral
// `/api/system/api-tokens` once they began authenticating REST as well as
// MCP. This path is preserved so the existing Settings UI and any operator
// scripts/bookmarks keep working — it wraps the same shared handlers. New
// callers should use `/api/system/api-tokens`.
export const dynamic = 'force-dynamic';

export const GET = withApiHandler({}, getTokensHandler);
// Minting a credential is a privileged, mutating administrative act, so a
// session bridged from a token must itself hold `mutate` to reach the handler
// (#2919) — a `read`-only principal may not mint at all, not even another
// `read` token that would outlive its own. `cookieScope`, not `tokenScope`:
// this route must stay cookie/internal-only, or a token could call the mint
// directly and hand itself an unparented, longer-lived twin. The handler then
// holds the request to the caller's own scopes.
export const POST = withApiHandler({ cookieScope: 'mutate' }, createTokenHandler);
export const DELETE = withApiHandler<undefined, z.infer<typeof DeleteTokenQuery>>(
  { query: DeleteTokenQuery },
  deleteTokenHandler,
);
