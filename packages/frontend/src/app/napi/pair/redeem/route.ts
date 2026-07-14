import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withApiHandler } from '@/lib/api/handler';
import { createToken } from '@/lib/auth/apiTokens';
import type { ApiScope } from '@/lib/auth/apiScope';
import { redeemCode, PAIRING_CODE_TTL_MS } from '@/lib/auth/pairingCodes';
import { logger } from '@/lib/logger';

/**
 * POST /napi/pair/redeem — the ONE public token-minting surface (#2251).
 *
 * A device (the Solaris-android companion app) that scanned/entered a pairing
 * code POSTs `{ code }` here to receive a READ-scoped `sb_` Bearer token. This
 * is the only endpoint on the box that hands a caller a token with NO prior
 * credential, so it is deliberately paranoid and FAIL-CLOSED:
 *   - The code must be valid, unexpired, and unused. `redeemCode` enforces
 *     single-use atomically (marks consumed before returning), constant-time
 *     compares the candidate, and rate-limits brute force. See pairingCodes.ts.
 *   - On ANY non-success branch (invalid / expired / already-used / missing /
 *     rate-limited) we return 40x and mint NOTHING — never a default token.
 *   - The minted token is READ scope ONLY. It can never carry
 *     lifecycle/mutate/destroy/reboot/exec — a leaked or guessed code, even if
 *     it slips through, buys at most read access, never the ability to change
 *     or destroy anything on the box.
 *
 * `skipAuth: true`: intentionally public — the pairing CODE is the credential.
 * `/napi/*` now runs through proxy.ts's gate (#2281), so this route has a
 * `csrfExempt` PUBLIC_API_RULES entry there: its legitimate caller (the companion
 * app) is cross-origin with no browser Origin, and the fail-closed checks here
 * (single-use + constant-time + rate-limited code → read-only token) are the
 * whole gate. `/napi/pair` (the mint) is deliberately NOT csrf-exempt — it stays
 * CSRF-gated so a direct forgery 403s.
 */

/** The minted token's scopes. READ ONLY — never widen this. The public redeem
 *  surface must not be able to hand out mutate/lifecycle/destroy authority. */
const REDEEM_SCOPES: ApiScope[] = ['read'];

/** Redeemed read tokens are long-lived enough to be useful to a paired device
 *  but still expire; 30 days keeps a lost device from holding read access
 *  forever. (The device can re-pair for a fresh token.) */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const bodySchema = z.object({
  code: z.string().min(1).max(64),
});

/** Map a fail-closed redeem reason to an HTTP status. Used/expired → 410 (the
 *  code existed but is gone); invalid/missing → 400; rate-limited → 429. All
 *  mint nothing. */
function statusFor(reason: 'invalid' | 'expired' | 'used' | 'rate_limited'): number {
  switch (reason) {
    case 'expired':
    case 'used':
      return 410;
    case 'rate_limited':
      return 429;
    case 'invalid':
    default:
      return 400;
  }
}

export const POST = withApiHandler({ skipAuth: true, body: bodySchema }, async (
  { body }: { body: z.infer<typeof bodySchema> },
) => {
  const result = redeemCode(body.code);
  if (!result.ok) {
    // FAIL-CLOSED: no token on any non-success branch.
    logger.warn('napi:pair:redeem', `Rejected pairing-code redeem (${result.reason})`);
    return NextResponse.json({ error: `pairing code ${result.reason}` }, { status: statusFor(result.reason) });
  }

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const { token, secret } = await createToken({
    name: `device-pairing:${result.createdBy}`.slice(0, 100),
    scopes: REDEEM_SCOPES,
    expiresAt,
    createdBy: `pairing:${result.createdBy}`,
  });

  logger.info(
    'napi:pair:redeem',
    `Minted READ-scoped device token ${token.id} via pairing code (creator=${result.createdBy}) expires=${expiresAt}`,
  );

  return NextResponse.json({
    token: secret,
    scopes: token.scopes,
    expires_at: expiresAt,
    // Echo the code TTL for context; the token TTL is separate and returned above.
    code_ttl_ms: PAIRING_CODE_TTL_MS,
  });
});
