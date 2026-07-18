/**
 * POST /api/auth/delegated-admin-from-authelia-session — session-driven
 * delegated-admin mint (#2275, SECURITY).
 *
 * The delegation analogue of #2246's token-from-authelia-session: a verified
 * *browser* Authelia admin session (NPM forward-auth Remote-User /
 * Remote-Groups) mints a SHORT-LIVED, SINGLE-USE `X-SB-Delegated-Admin`
 * assertion — WITHOUT the consumer ever holding the standing AUTH_SECRET-derived
 * delegationKey. ServiceBay holds the key server-side and only MINTS here.
 *
 * These tests drive the ACTUAL route module against the REAL delegatedAdmin /
 * delegationKey codec (no HMAC mocking) so the round-trip is genuine: a minted
 * assertion must be accepted by `verifyDelegatedAdmin` AND drive the approve
 * route AS the named admin. Only LLDAP (`userIsInLldapGroup`) and the audit sink
 * are stubbed — everything crypto is real. We assert the security invariants:
 *   - valid admin session → mints an assertion verifyDelegatedAdmin accepts;
 *   - non-admin session (Remote-Groups without admins) → 403, NO mint;
 *   - missing forward-auth identity → 401; client Bearer (off-proxy) → 403;
 *   - the assertion is short-TTL (expired → rejected) and single-use (reuse → 403);
 *   - the response body leaks NEITHER the raw delegationKey NOR AUTH_SECRET.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// AUTH_SECRET must be set BEFORE delegationKey derives (module reads it lazily,
// but set it here for determinism across the round-trip).
process.env.AUTH_SECRET = 'test-auth-secret-for-2275-round-trip';

const mocks = vi.hoisted(() => ({
  userIsInLldapGroup: vi.fn(),
  recordAudit: vi.fn(),
}));

// LLDAP admin re-derivation (the confused-deputy check inside verifyDelegatedAdmin)
// is the only external dependency of the verify round-trip we stub.
vi.mock('@/lib/lldap/client', () => ({
  userIsInLldapGroup: mocks.userIsInLldapGroup,
}));
vi.mock('@/lib/mcp/audit', () => ({
  recordAudit: mocks.recordAudit,
}));

import { POST } from './route';
import {
  verifyDelegatedAdmin,
  createInMemoryReplayGuard,
  MAX_ASSERTION_TTL_MS,
} from '@/lib/auth/delegatedAdmin';
import { resetDelegationKeyCache } from '@/lib/auth/delegationKey';

function req(headers: Record<string, string>, body: unknown = { action: 'approvals.approve', target: 'r1' }): NextRequest {
  return new NextRequest('http://localhost:5888/api/auth/delegated-admin-from-authelia-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-auth-secret-for-2275-round-trip';
  resetDelegationKeyCache();
  mocks.userIsInLldapGroup.mockReset();
  mocks.recordAudit.mockReset();
  mocks.userIsInLldapGroup.mockResolvedValue({ ok: true, inGroup: true });
  mocks.recordAudit.mockResolvedValue(undefined);
});

describe('delegated-admin-from-authelia-session — session-driven mint (#2275)', () => {
  it('mints an assertion that verifyDelegatedAdmin accepts AND runs AS the named admin', async () => {
    const res = await POST(req({ 'remote-user': 'alice', 'remote-groups': 'admins,users' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.header).toBe('x-sb-delegated-admin');
    expect(body.action).toBe('approvals.approve');
    expect(body.target).toBe('r1');
    expect(typeof body.assertion).toBe('string');

    // The minted assertion is accepted by the verifier, bound to this action/
    // target, and resolves to the admin from Remote-User.
    const verdict = await verifyDelegatedAdmin({
      rawAssertion: body.assertion,
      expectedAction: 'approvals.approve',
      expectedTarget: 'r1',
      callerPrincipal: 'token:solaris',
      replayGuard: createInMemoryReplayGuard(),
    });
    expect(verdict).toMatchObject({ ok: true, user: 'alice' });
  });

  it('binds to the requested action/target — a mint for deny is NOT accepted as approve', async () => {
    const res = await POST(
      req({ 'remote-user': 'alice', 'remote-groups': 'admins' }, { action: 'approvals.deny', target: 'r7' }),
    );
    const body = await res.json();
    const verdict = await verifyDelegatedAdmin({
      rawAssertion: body.assertion,
      expectedAction: 'approvals.approve', // route is doing approve, assertion is for deny
      expectedTarget: 'r7',
      callerPrincipal: 'token:solaris',
      replayGuard: createInMemoryReplayGuard(),
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'binding_mismatch' });
  });

  it('non-admin session (Remote-Groups without admins) → 403, NO mint', async () => {
    const res = await POST(req({ 'remote-user': 'bob', 'remote-groups': 'users' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.assertion).toBeUndefined();
  });

  it('no forward-auth identity (off the proxy path) → 401, NO mint', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.assertion).toBeUndefined();
  });

  it('REFUSES a client Bearer + spoofed Remote-Groups:admins (direct :5888 self-elevation) → 403, NO mint', async () => {
    const res = await POST(
      req({ authorization: 'Bearer sb_some_scoped_token', 'remote-user': 'evil', 'remote-groups': 'admins' }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.assertion).toBeUndefined();
  });

  it('rejects an unknown/too-broad action (narrow capability guard)', async () => {
    const res = await POST(
      req({ 'remote-user': 'alice', 'remote-groups': 'admins' }, { action: 'delete_service', target: 'media' }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.assertion).toBeUndefined();
  });

  it('requires a target', async () => {
    const res = await POST(
      req({ 'remote-user': 'alice', 'remote-groups': 'admins' }, { action: 'approvals.approve' }),
    );
    expect(res.status).toBe(400);
  });

  it('mints a SHORT-TTL assertion (<= MAX_ASSERTION_TTL_MS) — an expired one is rejected', async () => {
    const res = await POST(req({ 'remote-user': 'alice', 'remote-groups': 'admins' }));
    const body = await res.json();
    const ttl = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttl).toBeLessThanOrEqual(MAX_ASSERTION_TTL_MS + 1000);
    expect(ttl).toBeGreaterThan(0);

    // Verify with a clock past the expiry → rejected as expired (never accepted).
    const verdict = await verifyDelegatedAdmin({
      rawAssertion: body.assertion,
      expectedAction: 'approvals.approve',
      expectedTarget: 'r1',
      callerPrincipal: 'token:solaris',
      replayGuard: createInMemoryReplayGuard(),
      now: Date.now() + MAX_ASSERTION_TTL_MS + 1000,
    });
    expect(verdict).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('mints a SINGLE-USE assertion — a second verify with the same nonce is a replay (403)', async () => {
    const res = await POST(req({ 'remote-user': 'alice', 'remote-groups': 'admins' }));
    const body = await res.json();
    const guard = createInMemoryReplayGuard();
    const input = {
      rawAssertion: body.assertion,
      expectedAction: 'approvals.approve',
      expectedTarget: 'r1',
      callerPrincipal: 'token:solaris',
      replayGuard: guard,
    };
    const first = await verifyDelegatedAdmin(input);
    expect(first).toMatchObject({ ok: true, user: 'alice' });
    const second = await verifyDelegatedAdmin(input);
    expect(second).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('does NOT leak the raw delegationKey or AUTH_SECRET in the response', async () => {
    const res = await POST(req({ 'remote-user': 'alice', 'remote-groups': 'admins' }));
    const raw = await res.text();
    expect(raw).not.toContain(process.env.AUTH_SECRET as string);
    // The delegationKey is HMAC(AUTH_SECRET, label) as base64/hex — neither the
    // secret nor any key-material field name should appear.
    expect(raw.toLowerCase()).not.toContain('delegationkey');
    expect(raw.toLowerCase()).not.toContain('auth_secret');
    // Only the encoded assertion (claims '.' hmac) and metadata are returned.
    const body = JSON.parse(raw);
    expect(Object.keys(body).sort()).toEqual(['action', 'assertion', 'expiresAt', 'header', 'target']);
  });
});
