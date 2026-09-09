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

// Reading the list is held to `read` (#2944). The rows are `publicView` — no
// hash, no secret material — and the Settings → Security read-only view plus the
// hygiene summary are built from them, so a `read` principal enumerating token
// METADATA is a **deliberate decision** recorded here, not an oversight: with
// every write verb below held to `mutate`/`destroy`, the list confers no
// authority. What the hold does remove is the off-ladder principal — a
// `propose`- or `lifecycle`-only session can no longer inventory the box's
// credentials at all (scopes are not nested, `docs/SCOPE_AUDIT.md`).
export const GET = withApiHandler({ cookieScope: 'read' }, getTokensHandler);
// Minting a credential is a privileged, mutating administrative act, so a
// session bridged from a token must itself hold `mutate` to reach the handler
// (#2919) — a `read`-only principal may not mint at all, not even another
// `read` token that would outlive its own. `cookieScope`, not `tokenScope`:
// this route must stay cookie/internal-only, or a token could call the mint
// directly and hand itself an unparented, longer-lived twin. The handler then
// holds the request to the caller's own scopes.
export const POST = withApiHandler({ cookieScope: 'mutate' }, createTokenHandler);
// Revoking a credential is irreversible — the `destroy` tier (#2944). #2919 held
// the mint and left this verb open, so a `read`-only token bridged to a cookie at
// `POST /api/auth/session-from-token` could still delete every token on the box,
// including the operator's own. `cookieScope` for the same reason as POST: opening
// the Bearer branch would let a short-lived token administer credentials directly,
// escaping the delegation chain's TTL narrowing and cascading revocation.
export const DELETE = withApiHandler<undefined, z.infer<typeof DeleteTokenQuery>>(
  { cookieScope: 'destroy', query: DeleteTokenQuery },
  deleteTokenHandler,
);
