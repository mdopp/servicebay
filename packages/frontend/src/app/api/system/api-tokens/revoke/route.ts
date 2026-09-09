import { withApiHandler } from '@/lib/api/handler';
import { bulkRevokeTokensHandler, BulkRevokeBody } from '@/lib/api/apiTokenRoutes';
import type { z } from 'zod';

// Bulk revoke (#2608). A POST rather than a repeated DELETE because the whole
// point is that the operator confirms ONCE over a visible list — see
// `bulkRevokeTokensHandler` for the partial-failure and self-lockout rules.
// The wrapper's built-in gate covers auth (POST is a mutating verb) and hands
// the handler the session, which is what identifies the caller's own token.
export const dynamic = 'force-dynamic';

// `destroy`, same tier as the single-token DELETE it batches (#2944): "authed"
// was never enough here, because a `read`-only token traded for a cookie at
// `POST /api/auth/session-from-token` is authenticated. The self-lockout rule in
// the handler protects the caller's OWN token and nothing else — it is not a
// scope check, so up to 200 of someone else's tokens could go in one request.
// `cookieScope`, not `tokenScope`: this stays cookie/internal-only so a token
// can never administer credentials directly (#2919).
export const POST = withApiHandler<z.infer<typeof BulkRevokeBody>, undefined>(
  { cookieScope: 'destroy', body: BulkRevokeBody },
  bulkRevokeTokensHandler,
);
