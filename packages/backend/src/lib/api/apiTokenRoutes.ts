import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listTokens, createToken, createDelegatedToken, DelegateError, revokeToken, ALL_SCOPES, type ApiScope } from '@/lib/auth/apiTokens';
import { revokeBootstrapToken } from '@/lib/mcp/bootstrapToken';
import { requireSession } from '@/lib/api/requireSession';
import { apiError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

/**
 * Shared request handlers for the named-API-token endpoints (#1264). The
 * canonical route is `/api/system/api-tokens`; `/api/system/mcp-tokens` is a
 * back-compat alias. Both route files wrap these with `withApiHandler` (so
 * the adoption invariant holds) — the logic lives here, once.
 */

export async function getTokensHandler({ request }: { request: Request }) {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  const tokens = await listTokens();
  return NextResponse.json({ tokens });
}

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(ALL_SCOPES as [ApiScope, ...ApiScope[]])).min(1),
  expiresAt: z.string().datetime().optional(),
  // Non-expiring machine token (#2299). Opt-in; defaults false. HARD-guarded
  // below to read-only scopes — a never-expiring credential that could mutate
  // or destroy is a standing liability, so it's fail-closed to `read`.
  neverExpires: z.boolean().optional().default(false),
});

/** A never-expiring token may only carry the read scope (#2299). Any other
 *  requested scope is refused so an unattended, non-lapsing credential can
 *  never mutate/destroy/exec. Read is the single allowed scope (no implication
 *  path widens `read`, so an exact-equality check is correct and fail-closed). */
function neverExpiresScopesAreReadOnly(scopes: ApiScope[]): boolean {
  return scopes.every(s => s === 'read');
}

export async function createTokenHandler({ request }: { request: Request }) {
  // requireSession is re-run here (the wrapper already gated POST) to
  // recover the session's user for the token's `createdBy` field.
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = CreateBody.parse(await request.json());

    // Fail-closed guard (#2299): a never-expiring token is restricted to the
    // read scope. Reject (403) before minting if it asks for anything more.
    if (body.neverExpires && !neverExpiresScopesAreReadOnly(body.scopes)) {
      return NextResponse.json(
        { error: 'A never-expiring token may only carry the read scope. Remove the extra scopes or give the token an expiry.' },
        { status: 403 },
      );
    }

    const result = await createToken({
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt,
      neverExpires: body.neverExpires,
      createdBy: auth.user,
    });

    // First user-minted token closes the bootstrap-token bridge (#322).
    // The operator now has a real, scoped credential, so the bootstrap
    // token is expired (deactivated, not deleted — #1705). It stays
    // re-activatable from Settings → Security for reconnecting an MCP
    // client with the same token value (#1419/#1552).
    try {
      await revokeBootstrapToken();
    } catch (e) {
      logger.warn('api:system:api-tokens:post', `Could not auto-revoke bootstrap token after first mint: ${e instanceof Error ? e.message : String(e)}`);
    }

    // The clear-text secret is returned ONCE, here. The client must show
    // it to the operator and let them copy it before it's gone.
    return NextResponse.json({ token: result.token, secret: result.secret });
  } catch (e) {
    return apiError(e, { tag: 'api:system:api-tokens:post', status: 400 });
  }
}

const DelegateBody = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(ALL_SCOPES as [ApiScope, ...ApiScope[]])).min(1),
  expiresAt: z.string().datetime().optional(),
});

/**
 * Delegated child-mint (#2048): a *holder* of an existing API token mints a
 * child whose scopes ⊆ parent and whose TTL ≤ parent. The parent token is the
 * credential — presented as `Authorization: Bearer sb_…`, NOT a session cookie
 * — so a non-interactive automation can self-delegate. The route is mounted
 * with `skipAuth: true`: there is no fixed `tokenScope` to gate on (the parent
 * may hold any scope), so authentication is the parent-token verification
 * inside createDelegatedToken, which rejects an unknown/expired/bad parent 403.
 *
 * `parentId` is derived server-side from the verified parent — never accepted
 * from the request body — so a caller can't forge a lineage.
 */
export async function delegateTokenHandler({ request }: { request: Request }) {
  const authz = request.headers.get('authorization') ?? '';
  const parentRaw = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!parentRaw) {
    return NextResponse.json({ error: 'Bearer parent token required' }, { status: 401 });
  }
  try {
    const body = DelegateBody.parse(await request.json());
    const result = await createDelegatedToken({
      parentRaw,
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt,
    });
    return NextResponse.json({ token: result.token, secret: result.secret });
  } catch (e) {
    if (e instanceof DelegateError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return apiError(e, { tag: 'api:system:api-tokens:delegate', status: 400 });
  }
}

export const DeleteTokenQuery = z.object({ id: z.string().optional() });

export async function deleteTokenHandler({ query }: { query: z.infer<typeof DeleteTokenQuery> }) {
  const id = query.id;
  if (!id || !/^[0-9a-f]{8}$/.test(id)) {
    return NextResponse.json({ error: 'invalid token id' }, { status: 400 });
  }
  const ok = await revokeToken(id);
  if (!ok) return NextResponse.json({ error: 'token not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
