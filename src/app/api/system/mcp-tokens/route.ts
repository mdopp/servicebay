import { NextResponse } from 'next/server';
import { z } from 'zod';
import { listTokens, createToken, revokeToken, ALL_SCOPES, type ApiScope } from '@/lib/mcp/tokens';
import { revokeBootstrapToken } from '@/lib/mcp/bootstrapToken';
import { requireSession } from '@/lib/api/requireSession';
import { withApiHandler } from '@/lib/api/handler';
import { apiError } from '@/lib/api/errors';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler({}, async ({ request }) => {
  const auth = await requireSession(request);
  if (auth instanceof NextResponse) return auth;
  const tokens = await listTokens();
  return NextResponse.json({ tokens });
});

const CreateBody = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(ALL_SCOPES as [ApiScope, ...ApiScope[]])).min(1),
  expiresAt: z.string().datetime().optional(),
});

export const POST = withApiHandler({}, async ({ request }) => {
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

    // First user-minted MCP token closes the bootstrap-token bridge
    // (#322). The operator now has a real, scoped credential —
    // keeping the bootstrap entry around any longer is just attack
    // surface. Moved out of `createToken` itself in #601 so the
    // mcp/tokens ↔ mcp/bootstrapToken cycle is gone.
    try {
      await revokeBootstrapToken();
    } catch (e) {
      logger.warn('api:system:mcp-tokens:post', `Could not auto-revoke bootstrap token after first mint: ${e instanceof Error ? e.message : String(e)}`);
    }

    // The clear-text secret is returned ONCE, here. The client must show
    // it to the operator and let them copy it before it's gone.
    return NextResponse.json({ token: result.token, secret: result.secret });
  } catch (e) {
    return apiError(e, { tag: 'api:system:mcp-tokens:post', status: 400 });
  }
});

const DeleteQuery = z.object({ id: z.string().optional() });

export const DELETE = withApiHandler<undefined, z.infer<typeof DeleteQuery>>(
  { query: DeleteQuery },
  async ({ query }) => {
  const id = query.id;
  if (!id || !/^[0-9a-f]{8}$/.test(id)) {
    return NextResponse.json({ error: 'invalid token id' }, { status: 400 });
  }
  const ok = await revokeToken(id);
  if (!ok) return NextResponse.json({ error: 'token not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
});
