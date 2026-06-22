import { withApiHandler } from '@/lib/api/handler';
import { delegateTokenHandler } from '@/lib/api/apiTokenRoutes';

// Delegated child-mint (#2048) — foundation of the token chain-of-trust epic
// (#2047). A holder of an existing API token mints a child whose scopes ⊆ the
// parent and whose TTL ≤ the parent, presenting the parent as
// `Authorization: Bearer sb_…`. `skipAuth: true` because the parent token IS
// the credential: there is no fixed `tokenScope` to gate on (the parent may
// hold any scope), so authentication is the parent-token verification inside
// the handler, which rejects an unknown/expired/bad parent with 403.
export const dynamic = 'force-dynamic';

export const POST = withApiHandler({ skipAuth: true }, delegateTokenHandler);
