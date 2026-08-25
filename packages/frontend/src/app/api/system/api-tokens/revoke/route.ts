import { withApiHandler } from '@/lib/api/handler';
import { bulkRevokeTokensHandler, BulkRevokeBody } from '@/lib/api/apiTokenRoutes';
import type { z } from 'zod';

// Bulk revoke (#2608). A POST rather than a repeated DELETE because the whole
// point is that the operator confirms ONCE over a visible list — see
// `bulkRevokeTokensHandler` for the partial-failure and self-lockout rules.
// The wrapper's built-in gate covers auth (POST is a mutating verb) and hands
// the handler the session, which is what identifies the caller's own token.
export const dynamic = 'force-dynamic';

export const POST = withApiHandler<z.infer<typeof BulkRevokeBody>, undefined>(
  { body: BulkRevokeBody },
  bulkRevokeTokensHandler,
);
