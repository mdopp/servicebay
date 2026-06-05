import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listTokens, createToken, revokeToken, ALL_SCOPES, type ApiScope } from '@/lib/auth/apiTokens';
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
});

export async function createTokenHandler({ request }: { request: Request }) {
  // requireSession is re-run here (the wrapper already gated POST) to
  // recover the session's user for the token's `createdBy` field.
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  try {
    const body = CreateBody.parse(await request.json());
    const result = await createToken({
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt,
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
