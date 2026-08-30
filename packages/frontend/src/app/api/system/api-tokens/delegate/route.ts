import { withApiHandler } from '@/lib/api/handler';
import {
  delegateTokenHandler,
  revokeDelegatedTokenHandler,
  RevokeDelegatedQuery,
} from '@/lib/api/apiTokenRoutes';
import type { z } from 'zod';

// Delegated child-mint (#2048) — foundation of the token chain-of-trust epic
// (#2047). A holder of an existing API token mints a child whose scopes ⊆ the
// parent and whose TTL ≤ the parent, presenting the parent as
// `Authorization: Bearer sb_…`. `skipAuth: true` because the parent token IS
// the credential: there is no fixed `tokenScope` to gate on (the parent may
// hold any scope), so authentication is the parent-token verification inside
// the handler, which rejects an unknown/expired/bad parent with 403.
//
// DELETE is the same door in the other direction (#2680): the parent revokes
// ONE child it minted, so a non-interactive delegator can take its grant back
// without an operator session. Same credential, same `skipAuth` reasoning; the
// handler refuses any id that is not this parent's own child.
export const dynamic = 'force-dynamic';

export const POST = withApiHandler({ skipAuth: true }, delegateTokenHandler);
export const DELETE = withApiHandler<undefined, z.infer<typeof RevokeDelegatedQuery>>(
  { skipAuth: true, query: RevokeDelegatedQuery },
  revokeDelegatedTokenHandler,
);
