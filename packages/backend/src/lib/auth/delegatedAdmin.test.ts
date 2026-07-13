import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';

// #2270 — delegated-admin verification: every security-critical failure mode is
// tested explicitly. A bug that lets a forged/replayed assertion, or a
// non-admin, or a standing elevation through is the worst-case failure, so each
// gets its own case with a distinct failure reason asserted.

// Capture audit writes without touching the real fs.
const auditCalls: unknown[] = [];
vi.mock('@/lib/mcp/audit', () => ({
  recordAudit: vi.fn(async (e: unknown) => { auditCalls.push(e); }),
}));

// Mock LLDAP so the DEFAULT admin-check path (no injected adminCheck) is
// exercised deterministically — proves the guard really consults SB's own LLDAP.
const lldapMembers = new Set<string>();
let lldapErrors = false;
vi.mock('@/lib/lldap/client', () => ({
  userIsInLldapGroup: vi.fn(async (user: string, _group: string) => {
    if (lldapErrors) return { ok: false, reason: 'unreachable', message: 'LLDAP down' };
    return { ok: true, inGroup: lldapMembers.has(user), groups: lldapMembers.has(user) ? ['admins'] : [] };
  }),
}));

import {
  verifyDelegatedAdmin,
  encodeAssertion,
  createInMemoryReplayGuard,
  MAX_ASSERTION_TTL_MS,
  DELEGATION_HEADER,
  type DelegatedAssertion,
} from './delegatedAdmin';
import { resetDelegationKeyCache } from './delegationKey';

const ORIG = process.env.AUTH_SECRET;
const ADMIN = 'alice';
const NON_ADMIN = 'mallory';

function assertion(over: Partial<DelegatedAssertion> = {}): DelegatedAssertion {
  const now = Date.now();
  return {
    user: ADMIN,
    action: 'approvals.approve',
    target: 'appr-42',
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + 60_000,
    ...over,
  };
}

// A distinct guard + a stable clock per test.
let guard = createInMemoryReplayGuard();

beforeEach(() => {
  process.env.AUTH_SECRET = 'x'.repeat(48);
  resetDelegationKeyCache();
  auditCalls.length = 0;
  lldapMembers.clear();
  lldapMembers.add(ADMIN);
  lldapErrors = false;
  guard = createInMemoryReplayGuard();
});
afterEach(() => {
  if (ORIG === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = ORIG;
  resetDelegationKeyCache();
});

function verify(raw: string | null, over: { action?: string; target?: string } = {}) {
  return verifyDelegatedAdmin({
    rawAssertion: raw,
    expectedAction: over.action ?? 'approvals.approve',
    expectedTarget: over.target ?? 'appr-42',
    callerPrincipal: 'token:svc-solaris',
    replayGuard: guard,
  });
}

describe('verifyDelegatedAdmin', () => {
  it('exposes the stable wire header name (#2268 route wiring contract)', () => {
    expect(DELEGATION_HEADER).toBe('x-sb-delegated-admin');
  });

  it('accepts a valid assertion by a real admin and writes an audit record', async () => {
    const res = await verify(encodeAssertion(assertion()));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.user).toBe(ADMIN);
    expect(auditCalls).toHaveLength(1);
    const entry = auditCalls[0] as Record<string, unknown>;
    expect(entry.caller).toBe(ADMIN);
    expect(entry.tool).toBe('delegated:approvals.approve');
    expect((entry.args as Record<string, unknown>).assertedBy).toBe('token:svc-solaris');
    expect(entry.outcome).toBe('ok');
  });

  it('rejects an assertion naming a non-admin user even with a valid signature (confused-deputy)', async () => {
    // Correctly signed by the real key, but the named user is NOT in admins per
    // SB's LLDAP — the role is never trusted from the assertion.
    const res = await verify(encodeAssertion(assertion({ user: NON_ADMIN })));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not_admin');
    expect(auditCalls).toHaveLength(0);
  });

  it('rejects an expired assertion', async () => {
    const past = Date.now() - 10_000;
    const res = await verify(encodeAssertion(assertion({ iat: past - 60_000, exp: past })));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
  });

  it('rejects an over-long lifetime window', async () => {
    const now = Date.now();
    const res = await verify(encodeAssertion(assertion({ iat: now, exp: now + MAX_ASSERTION_TTL_MS + 1000 })));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_window');
  });

  it('rejects a replayed nonce (single-use within its lifetime)', async () => {
    const token = encodeAssertion(assertion());
    const first = await verify(token);
    expect(first.ok).toBe(true);
    const second = await verify(token);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('replayed');
    // Only the first (valid) use is audited.
    expect(auditCalls).toHaveLength(1);
  });

  it('rejects a tampered action (signature no longer matches)', async () => {
    // Sign for one action, present the wire token but ask the route to verify a
    // DIFFERENT action — the signature is over the original action, so editing
    // the claim would break the signature; here the mismatch is caught either as
    // bad_signature (edited claim) or binding_mismatch (route expectation). We
    // tamper the encoded claims blob to prove the signature guard fires.
    const a = assertion();
    const token = encodeAssertion(a);
    const [claimsB64, sig] = token.split('.');
    const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf-8'));
    claims.action = 'services.delete'; // attacker widens the action
    const forged = Buffer.from(JSON.stringify(claims), 'utf-8').toString('base64url') + '.' + sig;
    const res = await verify(forged, { action: 'services.delete' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('rejects a binding mismatch (valid signature, wrong target for this route)', async () => {
    // Legitimately signed for target appr-42, but the route is operating on a
    // different target — the action can't be redirected.
    const res = await verify(encodeAssertion(assertion({ target: 'appr-99' })), { target: 'appr-42' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('binding_mismatch');
  });

  it('rejects a signature made with the wrong key', async () => {
    const token = encodeAssertion(assertion());
    // Rotate the derivation key (as if a different box / wrong AUTH_SECRET) and
    // re-verify the previously-signed token.
    process.env.AUTH_SECRET = 'z'.repeat(48);
    resetDelegationKeyCache();
    const res = await verify(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('returns reason "missing" when no assertion is present (route falls back to other auth)', async () => {
    const res = await verify(null);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('missing');
  });

  it('rejects a malformed assertion header', async () => {
    const res = await verify('not-a-real-token');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('malformed');
  });

  it('fails closed on a directory error (deny rather than assume admin)', async () => {
    lldapErrors = true;
    const res = await verify(encodeAssertion(assertion()));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('directory_error');
    expect(auditCalls).toHaveLength(0);
  });

  it('does not burn a nonce when the assertion is rejected for binding (forged copy cannot exhaust a real nonce)', async () => {
    const a = assertion();
    // First, a mis-bound presentation that must NOT consume the nonce.
    const misbound = await verify(encodeAssertion(a), { target: 'wrong-target' });
    expect(misbound.ok).toBe(false);
    // The legitimate, correctly-bound presentation of the SAME nonce still works.
    const legit = await verify(encodeAssertion(a));
    expect(legit.ok).toBe(true);
  });
});
