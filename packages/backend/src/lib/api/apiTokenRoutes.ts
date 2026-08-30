import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  listTokens,
  createToken,
  createDelegatedToken,
  revokeDelegatedToken,
  DelegateError,
  revokeToken,
  revokeTokens,
  sweepExpiredTokens,
  summarizeTokenHygiene,
  EXPIRY_GRACE_MS,
  ALL_SCOPES,
  type ApiScope,
  type RevokeResult,
} from '@/lib/auth/apiTokens';
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
  // Opening the list is the natural moment to retire what has been dead for
  // longer than the grace window (#2606). The periodic server timer is the
  // real guarantee; this just means the operator never reads a stale list.
  await sweepExpiredTokens().catch(e =>
    logger.warn('api:system:api-tokens:get', `Expiry sweep failed: ${e instanceof Error ? e.message : String(e)}`));
  const tokens = await listTokens();
  return NextResponse.json({
    tokens,
    // Counted states the operator has to decide about (#2606) — notably the
    // never-expiring and never-used rows, which no sweep will ever remove.
    summary: { ...summarizeTokenHygiene(tokens), graceDays: EXPIRY_GRACE_MS / 86_400_000 },
    // The token this very session is riding on, when it was minted through the
    // token→session bridge. The UI locks it out of bulk selection so a cleanup
    // can't end with the operator logged out (#2608). `null` for a normal
    // password login — there is no "own token" to protect in that case.
    currentTokenId: auth.viaToken ?? null,
  });
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

export const RevokeDelegatedQuery = z.object({ id: z.string().optional() });

/**
 * Delegated child-REVOKE (#2680) — the counterpart of `delegateTokenHandler`,
 * on the same route and the same credential model (`Authorization: Bearer
 * sb_…` naming the parent; `skipAuth: true` because that token *is* the
 * authentication, verified inside `revokeDelegatedToken`).
 *
 * It exists because there was no way for a token holder to take back what it
 * delegated: `DELETE /api/system/api-tokens` carries no `tokenScope`, so it
 * accepts a session cookie only, and the claude-dev configuration UI has no
 * session — it holds one read-only `sb_` token and nothing else. Without this
 * the "remove a project" action could stop the session and leave the project's
 * credential live forever.
 *
 * The authority is deliberately narrow: a parent may revoke *its own children*
 * and nothing else. Anything else — an unknown id, a sibling of a different
 * parent, the parent itself — is refused (404/403) with the store untouched.
 */
export async function revokeDelegatedTokenHandler(
  { request, query }: { request: Request; query: z.infer<typeof RevokeDelegatedQuery> },
) {
  const authz = request.headers.get('authorization') ?? '';
  const parentRaw = authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
  if (!parentRaw) {
    return NextResponse.json({ error: 'Bearer parent token required' }, { status: 401 });
  }
  try {
    const revoked = await revokeDelegatedToken({ parentRaw, childId: query.id ?? '' });
    // `revoked: 1` so a caller that reads only the body still sees a
    // denominator rather than inferring success from a bare `ok`.
    return NextResponse.json({ ok: true, revoked: 1, id: revoked.id, name: revoked.name });
  } catch (e) {
    if (e instanceof DelegateError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return apiError(e, { tag: 'api:system:api-tokens:delegate:delete', status: 400 });
  }
}

const TOKEN_ID = /^[0-9a-f]{8}$/;

export const BulkRevokeBody = z.object({
  // Capped so a malformed/hostile caller can't ask the store to rewrite an
  // unbounded list; 200 is far above any real token population (the reference
  // box holds 34) and far below anything that would stall the write.
  ids: z.array(z.string()).min(1).max(200),
});

/**
 * Bulk revoke (#2608). One request, one confirmation, N tokens — because 34
 * separate typed confirmations is not extra care, it is training the operator
 * to confirm without reading (#2164's rule is preserved by the *single* typed
 * confirmation the UI puts in front of this, not by repeating it).
 *
 * Two things this must never do:
 *  - **Swallow a partial failure.** Every requested id comes back with its own
 *    `ok`, and the response carries `requested`/`revoked` so the caller can
 *    state the denominator ("9 of 12 revoked") instead of implying a clean run
 *    (#2461 — the single-revoke version of this bug).
 *  - **Lock the caller out of their own session.** A session bridged from a
 *    token (`viaToken`) refuses that token: revoking it kills the very session
 *    issuing the request, and it would happen mid-list with no way back.
 *
 * Status: 200 only when every id was revoked, 207 when some were, 422 when
 * none were. A caller that inspects nothing but the status code still cannot
 * read "nothing happened" as success.
 */
export async function bulkRevokeTokensHandler(
  { body, auth }: { body: z.infer<typeof BulkRevokeBody>; auth?: { viaToken?: string } },
) {
  const requested = [...new Set(body.ids)];
  const malformed = requested.filter(id => !TOKEN_ID.test(id));
  if (malformed.length > 0) {
    return NextResponse.json({ error: `invalid token id: ${malformed[0]}` }, { status: 400 });
  }

  const ownTokenId = auth?.viaToken;
  const refused: RevokeResult[] = [];
  const revokable = requested.filter(id => {
    if (ownTokenId && id === ownTokenId) {
      refused.push({ id, ok: false, error: 'this is the token your current session is using — revoking it would log you out' });
      return false;
    }
    return true;
  });

  const revoked = revokable.length > 0 ? await revokeTokens(revokable) : [];
  // Keep the caller's order so the UI can line results up with its selection.
  const byId = new Map([...revoked, ...refused].map(r => [r.id, r]));
  const results = requested.map(id => byId.get(id)!);
  const okCount = results.filter(r => r.ok).length;

  logger.info(
    'api:system:api-tokens:bulk-revoke',
    `Bulk revoke: ${okCount} of ${results.length} token(s) revoked${okCount < results.length ? `; failed: [${results.filter(r => !r.ok).map(r => r.id).join(',')}]` : ''}`,
  );

  const status = okCount === results.length ? 200 : okCount > 0 ? 207 : 422;
  return NextResponse.json({ requested: results.length, revoked: okCount, results }, { status });
}

export const DeleteTokenQuery = z.object({ id: z.string().optional() });

export async function deleteTokenHandler({ query }: { query: z.infer<typeof DeleteTokenQuery> }) {
  const id = query.id;
  if (!id || !TOKEN_ID.test(id)) {
    return NextResponse.json({ error: 'invalid token id' }, { status: 400 });
  }
  const ok = await revokeToken(id);
  if (!ok) return NextResponse.json({ error: 'token not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
