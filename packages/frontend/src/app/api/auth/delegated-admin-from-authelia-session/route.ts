import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { withApiHandler } from '@/lib/api/handler';
import {
  encodeAssertion,
  DELEGATION_HEADER,
  MAX_ASSERTION_TTL_MS,
  ADMIN_GROUP,
  type DelegatedAssertion,
} from '@/lib/auth/delegatedAdmin';
import { logger } from '@/lib/logger';

/**
 * Authelia-session → short-lived delegated-admin assertion (#2275).
 *
 * The DELEGATION analogue of `/api/auth/token-from-authelia-session` (#2246):
 * a verified admin's *live* Authelia session mints a SHORT-LIVED, SINGLE-PURPOSE
 * delegated-admin assertion (the `X-SB-Delegated-Admin` value) — WITHOUT the
 * consumer (e.g. the Solaris BFF pod) ever holding the standing AUTH_SECRET-
 * derived `delegationKey`. ServiceBay already holds that key server-side; here
 * SB VERIFIES the admin session and MINTS the assertion with `encodeAssertion`,
 * so the key never leaves the box. The consumer then presents the returned
 * assertion to `POST /napi/approvals/:id/{approve,deny}`, where
 * `verifyDelegatedAdmin` re-validates it (signature, window, replay, and the
 * LLDAP admin re-derivation of the named user).
 *
 * WHY — #2272 shipped delegated-admin, but the ONLY way to mint the assertion
 * was to HOLD the AUTH_SECRET-derived key in the consumer pod (a 24/7 root-of-
 * trust admin credential — the exact anti-pattern #2246 avoided for the SB-MCP
 * token). This endpoint moves the authority back to the live admin session:
 * nothing standing in the consumer pod, the assertion expires in ≤2 minutes and
 * is single-use.
 *
 * TRUST MODEL — read before touching the header check (identical to #2246):
 *   The `Remote-User` / `Remote-Groups` headers are trustworthy ONLY because
 *   NPM's forward-auth snippet (`stackInstall/forwardAuth.ts`) sets them via
 *   `proxy_set_header Remote-User $user;` from the Authelia auth-request
 *   subrequest, OVERWRITING any client-supplied copy (ADR 0009 §2 — Remote-*
 *   trusted only on the LAN-gated proxy path). A request that actually carries
 *   these headers has been through Authelia. A request WITHOUT them
 *   (direct/loopback, or a public host not fronted by the forward-auth chain) is
 *   NOT trusted — missing `Remote-User` → 401, never an assertion.
 *
 * PRIVILEGE-ESCALATION GUARD (#2246/#2249, SECURITY):
 *   On a DIRECT `:5888` call (bypassing NPM) a Bearer holder passes proxy.ts's
 *   `isValidBearerToken()` gate and could then supply its OWN `Remote-User: evil`
 *   / `Remote-Groups: admins` headers (nothing upstream overwrote them) → mint an
 *   admin assertion = self-elevation. So we REFUSE any request that presents a
 *   client Bearer (403, mint nothing). Identity here may only come from the
 *   proxy-injected forward-auth headers, never from a caller who is already a
 *   token.
 *
 * `skipAuth: true`: the Authelia proxy headers ARE the credential (mirrors
 * `/api/auth/token-from-authelia-session`). No cookie/admin session is required.
 */

/** The narrow, app-agnostic capability this endpoint mints for: the approvals
 *  verdict actions `verifyDelegatedAdmin` binds to (`approvals.<verb>`). The
 *  request names one; anything else is refused. Keeping the set explicit means a
 *  minted assertion can only ever deliver an approve/deny verdict — never be
 *  redirected to some other admin op. */
const ALLOWED_ACTIONS = new Set(['approvals.approve', 'approvals.deny']);

interface MintRequest {
  /** The bound action, e.g. "approvals.approve" — must be in ALLOWED_ACTIONS. */
  action?: unknown;
  /** The bound target — the approval id the verdict operates on. */
  target?: unknown;
}

function parseGroups(raw: string | null): string[] {
  return (raw || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
}

export const POST = withApiHandler({ skipAuth: true }, async ({ request }: { request: NextRequest }) => {
  // PRIVILEGE-ESCALATION GUARD (#2249): refuse any caller presenting a client
  // Bearer token — a token client reaching here on a direct :5888 call could set
  // its OWN Remote-User/Remote-Groups and self-elevate to an admin assertion.
  const authz = request.headers.get('authorization');
  if (authz && authz.startsWith('Bearer ')) {
    logger.warn(
      'api:auth:delegated-admin-from-authelia-session',
      'Refused mint: request carried a client Bearer token (not a browser Authelia session)',
    );
    return NextResponse.json(
      { error: 'This endpoint is for a browser Authelia session; a token client may not mint an assertion here' },
      { status: 403 },
    );
  }

  // Only the proxy-injected identity is trusted (see TRUST MODEL above).
  const user = request.headers.get('remote-user');
  if (!user) {
    return NextResponse.json(
      { error: 'Authelia forward-auth identity required (no Remote-User header)' },
      { status: 401 },
    );
  }

  const groups = parseGroups(request.headers.get('remote-groups'));
  if (!groups.includes(ADMIN_GROUP)) {
    logger.warn(
      'api:auth:delegated-admin-from-authelia-session',
      `Denied mint for "${user}": not in "${ADMIN_GROUP}" (groups=[${groups.join(',')}])`,
    );
    return NextResponse.json(
      { error: `User is not in the "${ADMIN_GROUP}" group` },
      { status: 403 },
    );
  }

  // The assertion is action+target-bound (the confused-deputy binding
  // `verifyDelegatedAdmin` enforces). The caller names the exact verdict it is
  // about to deliver; a minted assertion can only ever be used for THAT op.
  let body: MintRequest;
  try {
    body = (await request.json()) as MintRequest;
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON { action, target }' }, { status: 400 });
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const target = typeof body.target === 'string' ? body.target : '';
  if (!ALLOWED_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${[...ALLOWED_ACTIONS].join(', ')}` },
      { status: 400 },
    );
  }
  if (!target) {
    return NextResponse.json({ error: 'target (the approval id) is required' }, { status: 400 });
  }

  // Mint the SHORT-LIVED, SINGLE-USE assertion server-side. TTL is the same
  // MAX_ASSERTION_TTL_MS (≤2min) the verifier caps at (a longer window would be
  // rejected as `bad_window`); the unique nonce makes it single-use via the
  // verifier's replay guard. `user` comes from the verified Remote-User; the
  // named user is re-checked against SB's own LLDAP at verify time.
  const iat = Date.now();
  const assertion: DelegatedAssertion = {
    user,
    action,
    target,
    nonce: crypto.randomUUID(),
    iat,
    exp: iat + MAX_ASSERTION_TTL_MS,
  };
  const encoded = encodeAssertion(assertion);

  logger.info(
    'api:auth:delegated-admin-from-authelia-session',
    `Minted delegated-admin assertion for admin "${user}" action=${action} target=${target} exp=${new Date(assertion.exp).toISOString()}`,
  );

  // Return the assertion (the DELEGATION_HEADER value) and the header name so the
  // consumer knows where to present it. The raw delegationKey / AUTH_SECRET is
  // NEVER returned — only the HMAC output baked into the encoded assertion.
  return NextResponse.json({
    assertion: encoded,
    header: DELEGATION_HEADER,
    action,
    target,
    expiresAt: new Date(assertion.exp).toISOString(),
  });
});
