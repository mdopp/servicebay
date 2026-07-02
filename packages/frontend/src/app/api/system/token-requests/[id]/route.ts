import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandlerParams } from '@/lib/api/handler';
import {
  approveTokenRequest,
  denyTokenRequest,
  TokenRequestError,
} from '@/lib/auth/tokenRequests';
import { ALL_SCOPES } from '@/lib/auth/apiScope';

/**
 * Admin approve/deny for one MCP scoped-token request (#2139).
 *
 * PATCH { action: "approve", scopes?, ttl_seconds? } — approve, optionally
 *   NARROWING the granted scopes (must be a subset of what was requested —
 *   least privilege) and/or overriding the TTL. Mints the sb_ token; the
 *   caller collects it once via poll_token_request. The response never carries
 *   the secret (only the request lifecycle).
 * PATCH { action: "deny" } — deny; no token is minted.
 *
 * Session-gated (defense-in-depth via withApiHandlerParams). Only an admin
 * with a session should ever hit this — approving a token is a privilege
 * escalation for the requester.
 */
export const dynamic = 'force-dynamic';

type Params = { id: string };

const PatchBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    scopes: z.array(z.enum(ALL_SCOPES as [string, ...string[]])).min(1).optional(),
    ttl_seconds: z.number().int().positive().optional(),
  }),
  z.object({ action: z.literal('deny') }),
]);

export const PATCH = withApiHandlerParams<z.infer<typeof PatchBody>, undefined, Params>(
  { body: PatchBody },
  async ({ params, body, auth }) => {
    try {
      if (body.action === 'deny') {
        const view = await denyTokenRequest(params.id);
        return { request: view };
      }
      const view = await approveTokenRequest(params.id, {
        scopes: body.scopes as Parameters<typeof approveTokenRequest>[1]['scopes'],
        ttlSecs: body.ttl_seconds,
        approvedBy: auth?.user,
      });
      return { request: view };
    } catch (e) {
      if (e instanceof TokenRequestError) {
        return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
      }
      throw e;
    }
  },
);
