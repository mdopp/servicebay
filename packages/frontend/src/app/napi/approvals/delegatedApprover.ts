import { NextRequest, NextResponse } from 'next/server';
import type { SessionPayload } from '@/lib/auth/session';
import {
  verifyDelegatedAdmin,
  DELEGATION_HEADER,
} from '@/lib/auth/delegatedAdmin';

/**
 * Delegated-admin auth mode for the /napi approve|deny verdict routes (#2268,
 * ADR 0010 on #2270).
 *
 * These routes already accept a `mutate`-scoped device token / operator session
 * (shipped #2253). This helper LAYERS the #2270 delegated-admin assertion on top
 * so a trusted server-server caller (Solaris) can deliver a verdict AS an
 * authenticated ServiceBay admin user — the mutation is gated by a REAL admin
 * per SB's own LLDAP (confused-deputy mitigation), not by the raw ambient token.
 *
 * The two-part credential is verified upstream + here:
 *   - the caller's `mutate` service token is checked by the handler's
 *     `tokenScope: 'mutate'` gate BEFORE the route body runs (a missing/wrong
 *     token is a 401 there, never reaching this helper);
 *   - the `X-SB-Delegated-Admin` assertion is verified here, action/target-bound
 *     to `approvals.<verb>` + this approval id, and the named user re-checked
 *     against SB's own LLDAP. `verifyDelegatedAdmin` writes the audit record.
 *
 * Return contract:
 *   - `{ mode: 'delegated', user }` — a valid assertion; run the verdict AS
 *     `user` (a real admin), audited by the guard.
 *   - `{ mode: 'fallback' }` — NO assertion header; the route keeps its existing
 *     device-token/session path (the layering requirement).
 *   - `{ mode: 'reject', response }` — an assertion WAS presented but is invalid
 *     (bad signature / expired / replayed / mis-bound / non-admin / directory
 *     error). The route returns the 403 as-is; it must NOT silently fall back
 *     to the raw-token path (that would let a forged assertion be ignored rather
 *     than refused).
 */
export type DelegatedApprover =
  | { mode: 'delegated'; user: string }
  | { mode: 'fallback' }
  | { mode: 'reject'; response: NextResponse };

/**
 * @param verb  the approval verb this route performs — 'approve' | 'deny'.
 * @param id    the decoded approval id the route is operating on (the binding
 *              target the assertion must match).
 * @param auth  the already-authenticated caller principal (the service token id),
 *              recorded in the audit trail as asserted-by.
 */
export async function resolveDelegatedApprover(
  request: NextRequest,
  verb: 'approve' | 'deny',
  id: string,
  auth: SessionPayload | undefined,
): Promise<DelegatedApprover> {
  const rawAssertion = request.headers.get(DELEGATION_HEADER);
  if (!rawAssertion) return { mode: 'fallback' };

  const result = await verifyDelegatedAdmin({
    rawAssertion,
    expectedAction: `approvals.${verb}`,
    expectedTarget: id,
    callerPrincipal: auth?.user ?? 'unknown',
  });

  if (result.ok) return { mode: 'delegated', user: result.user };

  // A `missing` reason cannot occur (we checked the header is present above),
  // but treat any non-ok result as a refusal: an assertion was presented and is
  // invalid → 403, NEVER a silent fall-through to the raw-token path.
  return {
    mode: 'reject',
    response: NextResponse.json({ error: result.message }, { status: 403 }),
  };
}
