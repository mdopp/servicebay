/**
 * Delegated-admin verification (#2270, ADR 0011 on ADR 0009).
 *
 * The MECHANISM by which a trusted server-server caller (Solaris) may perform a
 * MUTATING admin action AS an authenticated admin user WITHOUT becoming a
 * confused deputy. This is a REUSABLE guard the mutation routes opt into
 * (wiring into the approve/deny routes is #2268); read-only aggregation never
 * uses it.
 *
 * The two-part credential (operator-approved design):
 *   1. CALLER AUTH — the caller presents its existing ADR-0009 scoped service
 *      token (`sb_<id>_<secret>` Bearer). That is verified by the normal
 *      requireSession/tokenScope gate BEFORE this guard runs; this guard only
 *      accepts an already-authenticated caller principal. A missing/invalid
 *      service token is a 401 at the gate — never reaches here.
 *   2. USER+SCOPE ASSERTION — on top of the service token, the caller sends a
 *      SHORT-LIVED, ACTION-BOUND assertion `{user, action, target, nonce, iat,
 *      exp}` HMAC-signed with the delegation trust key (derived from the
 *      ADR-0009 root-of-trust AUTH_SECRET — see delegationKey.ts; survives a
 *      wipe-config reinstall).
 *
 * ServiceBay verifies ALL of, fail-closed:
 *   - signature valid (constant-time HMAC compare over the canonical payload);
 *   - not expired (`exp` in the future) and sane window (`exp - iat` ≤ MAX_TTL);
 *   - nonce not replayed (single-use within the assertion's own lifetime);
 *   - the requested `action`/`target` match what the route is actually doing
 *     (binding — the assertion can't be redirected to a different op);
 *   - the named `user` is ACTUALLY in the `admins` group per ServiceBay's OWN
 *     LLDAP (NOT the assertion's role claim — the confused-deputy mitigation).
 *
 * On success the route executes the action IN THAT USER'S NAME and an AUDIT
 * record is written (who/what/when/asserted-by-which-service-token). Any check
 * failing → the route returns 403.
 *
 * This is an ADDITIONAL accepted auth mode. It does not replace the existing
 * device-token / operator-session paths on the mutation routes — those keep
 * working; a route calls this guard only when the caller supplied an assertion.
 */
import crypto from 'node:crypto';
import { getDelegationKey } from './delegationKey';
import { userIsInLldapGroup } from '@/lib/lldap/client';
import { recordAudit } from '@/lib/mcp/audit';
import { logger } from '@/lib/logger';

/** The group whose membership grants admin — matches Authelia's access rules
 *  and lanDeniedPage's admin-only classification (ADR 0009 §2). */
export const ADMIN_GROUP = 'admins';

/** Header the caller puts the base64url-encoded signed assertion on. */
export const DELEGATION_HEADER = 'x-sb-delegated-admin';

/** Max assertion lifetime. Short by design — the assertion is action-bound and
 *  single-use, so a 2-minute window bounds the replay/clock-skew surface. */
export const MAX_ASSERTION_TTL_MS = 2 * 60 * 1000;

/** The signed claims. `iat`/`exp` are epoch milliseconds. */
export interface DelegatedAssertion {
  /** LLDAP user id the caller wants to act AS (verified against SB's LLDAP). */
  user: string;
  /** The bound action, e.g. "approvals.approve". Must match the route. */
  action: string;
  /** The bound target, e.g. the approval id or service name. Must match. */
  target: string;
  /** Unique per assertion — replay guard key. */
  nonce: string;
  /** Issued-at (epoch ms). */
  iat: number;
  /** Expiry (epoch ms). */
  exp: number;
}

export type DelegationFailureReason =
  | 'missing'          // no assertion header — the route should fall back to its other auth modes
  | 'malformed'        // header present but not a decodable/valid-shape assertion
  | 'bad_signature'
  | 'expired'
  | 'bad_window'       // exp<=iat or exp-iat > MAX_TTL
  | 'replayed'
  | 'binding_mismatch' // action/target don't match the request
  | 'not_admin'        // named user is not in admins per SB's own LLDAP
  | 'directory_error'; // LLDAP unreachable/misconfigured → fail closed

export type DelegationResult =
  | { ok: true; user: string; assertion: DelegatedAssertion }
  | { ok: false; reason: DelegationFailureReason; message: string };

/**
 * Canonical bytes signed by the assertion. Field order is FIXED and every field
 * is included — an attacker who edits any claim (including action/target)
 * invalidates the signature. JSON with sorted, explicit keys keeps client and
 * server byte-identical.
 */
function canonicalPayload(a: DelegatedAssertion): string {
  return JSON.stringify({
    action: a.action,
    exp: a.exp,
    iat: a.iat,
    nonce: a.nonce,
    target: a.target,
    user: a.user,
  });
}

/** Compute the base64url HMAC-SHA256 over an assertion's canonical payload. */
function signAssertion(a: DelegatedAssertion): string {
  return crypto.createHmac('sha256', getDelegationKey())
    .update(canonicalPayload(a))
    .digest('base64url');
}

/**
 * Mint a wire token for an assertion: base64url(JSON claims) + "." +
 * base64url(HMAC). Exported so the trusted CALLER side (and tests) produce the
 * exact byte layout the verifier expects — a shared codec, not a duplicated
 * format that could drift. ServiceBay itself only ever VERIFIES.
 */
export function encodeAssertion(a: DelegatedAssertion): string {
  const claims = Buffer.from(canonicalPayload(a), 'utf-8').toString('base64url');
  return `${claims}.${signAssertion(a)}`;
}

/** Structural validation of the parsed claims object. A non-empty string is
 *  required for identity/binding fields; `target` may be empty (some ops bind
 *  to an action alone); iat/exp must be finite numbers. */
function isValidClaims(o: Record<string, unknown>): boolean {
  const str = (v: unknown, allowEmpty = false) => typeof v === 'string' && (allowEmpty || v.length > 0);
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return str(o.user) && str(o.action) && str(o.target, true) && str(o.nonce) && num(o.iat) && num(o.exp);
}

/** Parse + shape-check the wire token. Returns the claims and the presented
 *  signature, or null if the token is structurally invalid. */
function decodeAssertion(raw: string): { assertion: DelegatedAssertion; signature: string } | null {
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const signature = raw.slice(dot + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw.slice(0, dot), 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (!isValidClaims(o)) return null;
  return {
    assertion: {
      user: o.user as string, action: o.action as string, target: o.target as string,
      nonce: o.nonce as string, iat: o.iat as number, exp: o.exp as number,
    },
    signature,
  };
}

// ---------------------------------------------------------------------------
// Replay guard — a nonce may be used at most ONCE within its assertion's own
// lifetime. In-memory + bounded by exp: since assertions live ≤ MAX_TTL, a
// nonce need only be remembered until its exp passes. A same-process replay is
// caught here; a cross-restart replay is bounded by the ≤2-min exp window
// (verifyExpiry rejects anything already expired). The store is injectable so a
// later unit can back it with shared/persisted storage if the deployment ever
// runs multiple ServiceBay processes.
// ---------------------------------------------------------------------------

export interface ReplayGuard {
  /** Record a nonce as consumed until `expEpochMs`. Returns false if the nonce
   *  was ALREADY consumed (a replay), true if this is its first use. */
  consume(nonce: string, expEpochMs: number): boolean;
}

class InMemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>(); // nonce -> exp (epoch ms)

  consume(nonce: string, expEpochMs: number): boolean {
    const now = Date.now();
    this.sweep(now);
    if (this.seen.has(nonce)) return false; // replay
    this.seen.set(nonce, expEpochMs);
    return true;
  }

  private sweep(now: number): void {
    for (const [n, exp] of this.seen) {
      if (exp <= now) this.seen.delete(n);
    }
  }
}

const defaultReplayGuard: ReplayGuard = new InMemoryReplayGuard();

/** Test-only: a fresh in-memory guard so a test's nonces don't collide across
 *  cases (and to assert replay behaviour in isolation). */
export function createInMemoryReplayGuard(): ReplayGuard {
  return new InMemoryReplayGuard();
}

// ---------------------------------------------------------------------------

export interface VerifyDelegatedAdminInput {
  /** The raw wire assertion (the DELEGATION_HEADER value). */
  rawAssertion: string | null | undefined;
  /** The action the route is actually about to perform. */
  expectedAction: string;
  /** The target the route is actually operating on (approval id / service). */
  expectedTarget: string;
  /** The already-authenticated caller principal (the service token id, e.g.
   *  `token:ab12cd34`), recorded in the audit trail as asserted-by. */
  callerPrincipal: string;
  /** Injectable for tests / future persisted store. */
  replayGuard?: ReplayGuard;
  /** Injectable clock for tests. */
  now?: number;
  /** Injectable admin-membership check for tests (defaults to SB's LLDAP). */
  adminCheck?: (user: string) => Promise<{ ok: true; inGroup: boolean } | { ok: false; message: string }>;
}

const failMessages: Record<DelegationFailureReason, string> = {
  missing: 'No delegated-admin assertion present.',
  malformed: 'Delegated-admin assertion is malformed.',
  bad_signature: 'Delegated-admin assertion signature is invalid.',
  expired: 'Delegated-admin assertion has expired.',
  bad_window: 'Delegated-admin assertion lifetime is invalid.',
  replayed: 'Delegated-admin assertion nonce has already been used.',
  binding_mismatch: 'Delegated-admin assertion is not bound to this action/target.',
  not_admin: 'Asserted user is not a ServiceBay admin.',
  directory_error: 'Could not verify admin membership against the identity directory.',
};

function fail(reason: DelegationFailureReason): DelegationResult {
  return { ok: false, reason, message: failMessages[reason] };
}

/** Constant-time compare of two base64url signature strings. */
function signaturesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function defaultAdminCheck(
  user: string,
): Promise<{ ok: true; inGroup: boolean } | { ok: false; message: string }> {
  const r = await userIsInLldapGroup(user, ADMIN_GROUP);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, inGroup: r.inGroup };
}

/**
 * The synchronous, side-effect-free checks on a presented assertion: decode,
 * signature, window/expiry, and action/target binding. Split out of
 * verifyDelegatedAdmin so the async guard stays within the complexity budget
 * and the ordering (crypto before any state change) is explicit. Returns the
 * parsed assertion on success, or the specific failure reason.
 */
function checkAssertionShape(
  rawAssertion: string,
  expectedAction: string,
  expectedTarget: string,
  now: number,
): { ok: true; assertion: DelegatedAssertion } | { ok: false; reason: DelegationFailureReason } {
  const decoded = decodeAssertion(rawAssertion);
  if (!decoded) return { ok: false, reason: 'malformed' };
  const { assertion, signature } = decoded;

  // 1. Signature over the FULL canonical payload — any tampered claim fails.
  if (!signaturesEqual(signature, signAssertion(assertion))) {
    return { ok: false, reason: 'bad_signature' };
  }
  // 2. Window sanity, then expiry.
  if (!(assertion.exp > assertion.iat) || assertion.exp - assertion.iat > MAX_ASSERTION_TTL_MS) {
    return { ok: false, reason: 'bad_window' };
  }
  if (assertion.exp <= now) return { ok: false, reason: 'expired' };
  // 3. Binding — signed action/target must match what the route is doing.
  if (assertion.action !== expectedAction || assertion.target !== expectedTarget) {
    return { ok: false, reason: 'binding_mismatch' };
  }
  return { ok: true, assertion };
}

/**
 * Verify a delegated-admin assertion. Runs every check fail-closed and in an
 * order that avoids side effects on a bad token: cheap crypto/shape/window
 * checks first, then the replay-consume (which MUST only fire on an otherwise
 * valid, correctly-bound assertion so a forged nonce can't burn a real one),
 * then the LLDAP admin-membership check last (a network round-trip).
 *
 * `reason: 'missing'` is distinguished so a route can FALL BACK to its existing
 * device-token/session auth when no assertion was supplied (layering); every
 * other failure means an assertion WAS presented but is invalid → 403.
 *
 * On success writes an audit record: who (user), what (action+target), when,
 * asserted-by (callerPrincipal), and returns the resolved user so the route
 * executes in that user's name.
 */
export async function verifyDelegatedAdmin(input: VerifyDelegatedAdminInput): Promise<DelegationResult> {
  const {
    rawAssertion, expectedAction, expectedTarget, callerPrincipal,
    replayGuard = defaultReplayGuard,
    now = Date.now(),
    adminCheck = defaultAdminCheck,
  } = input;

  if (!rawAssertion) return fail('missing');

  // Steps 1-3: decode + signature + window/expiry + action/target binding.
  // All synchronous and side-effect-free — no nonce is consumed and no network
  // call is made until the assertion is proven authentic and correctly bound.
  const shape = checkAssertionShape(rawAssertion, expectedAction, expectedTarget, now);
  if (!shape.ok) return fail(shape.reason);
  const { assertion } = shape;

  // 4. Replay — consume the nonce ONLY now that the assertion is otherwise
  //    valid and correctly bound, so an attacker can't burn a legitimate nonce
  //    with a mis-bound/forged copy. Remembered until the assertion's exp.
  if (!replayGuard.consume(assertion.nonce, assertion.exp)) return fail('replayed');

  // 5. Admin membership per SB's OWN LLDAP — never trust a role claim in the
  //    assertion. This is the confused-deputy mitigation. Fail CLOSED on a
  //    directory error (deny rather than assume admin).
  let admin: { ok: true; inGroup: boolean } | { ok: false; message: string };
  try {
    admin = await adminCheck(assertion.user);
  } catch (e) {
    logger.warn('auth:delegatedAdmin', `admin check threw for ${assertion.user}: ${e instanceof Error ? e.message : String(e)}`);
    return fail('directory_error');
  }
  if (!admin.ok) {
    logger.warn('auth:delegatedAdmin', `admin check failed for ${assertion.user}: ${admin.message}`);
    return fail('directory_error');
  }
  if (!admin.inGroup) return fail('not_admin');

  // Success — record the delegation in the audit trail (who/what/when/by-whom).
  await recordAudit({
    ts: new Date(now).toISOString(),
    tool: `delegated:${assertion.action}`,
    caller: assertion.user,
    outcome: 'ok',
    durationMs: 0,
    args: { target: assertion.target, assertedBy: callerPrincipal, nonce: assertion.nonce },
  });

  return { ok: true, user: assertion.user, assertion };
}
