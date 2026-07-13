/**
 * POST /napi/pair/redeem — the ONE public token-minting surface (#2251).
 *
 * Fail-closed: only a valid+unused+unexpired code mints a token, and the minted
 * token is READ scope ONLY. We drive the actual route, mocking the pairing store
 * (unit-tested separately) + createToken, and assert:
 *   - valid code → 200 + a read-scoped `sb_` token
 *   - the mint is called with scopes:['read'] and NOTHING broader
 *   - used / expired / invalid / rate-limited → 40x, createToken NEVER called
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { scopeSatisfiedBy } from '@/lib/auth/apiScope';

const mocks = vi.hoisted(() => ({
  redeemCode: vi.fn(),
  createToken: vi.fn(),
}));

vi.mock('@/lib/auth/pairingCodes', () => ({
  redeemCode: mocks.redeemCode,
  PAIRING_CODE_TTL_MS: 5 * 60 * 1000,
}));
vi.mock('@/lib/auth/apiTokens', () => ({
  createToken: mocks.createToken,
}));

import { POST } from './route';

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost:5888/napi/pair/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /napi/pair/redeem — public, fail-closed, read-scoped only', () => {
  beforeEach(() => {
    mocks.redeemCode.mockReset();
    mocks.createToken.mockReset();
    mocks.createToken.mockResolvedValue({
      token: { id: 'dev1', name: 'device-pairing', scopes: ['read'] },
      secret: 'sb_dev1_readsecret',
    });
  });

  it('valid code → 200 + a READ-scoped sb_ token', async () => {
    mocks.redeemCode.mockReturnValue({ ok: true, createdBy: 'authelia:alice' });
    const res = await POST(req({ code: 'ABC234' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.token).toBe('sb_dev1_readsecret');
    expect(body.scopes).toEqual(['read']);
  });

  it('mints with scopes:["read"] ONLY — never lifecycle/mutate/destroy', async () => {
    mocks.redeemCode.mockReturnValue({ ok: true, createdBy: 'authelia:alice' });
    await POST(req({ code: 'ABC234' }));
    expect(mocks.createToken).toHaveBeenCalledOnce();
    const arg = mocks.createToken.mock.calls[0][0];
    expect(arg.scopes).toEqual(['read']);
    for (const bad of ['lifecycle', 'mutate', 'destroy', 'reboot', 'exec']) {
      expect(arg.scopes).not.toContain(bad);
    }
    // Acceptance #5: the read scope satisfies a read gate but NOT mutate/destroy —
    // proven against the real scope ladder (what the MCP/REST gate enforces).
    expect(scopeSatisfiedBy(arg.scopes, 'read')).toBe(true);
    expect(scopeSatisfiedBy(arg.scopes, 'mutate')).toBe(false);
    expect(scopeSatisfiedBy(arg.scopes, 'destroy')).toBe(false);
    expect(scopeSatisfiedBy(arg.scopes, 'lifecycle')).toBe(false);
  });

  it('USED code → 410, mints NOTHING', async () => {
    mocks.redeemCode.mockReturnValue({ ok: false, reason: 'used' });
    const res = await POST(req({ code: 'ABC234' }));
    expect(res.status).toBe(410);
    expect(mocks.createToken).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.token).toBeUndefined();
  });

  it('EXPIRED code → 410, mints NOTHING', async () => {
    mocks.redeemCode.mockReturnValue({ ok: false, reason: 'expired' });
    const res = await POST(req({ code: 'ABC234' }));
    expect(res.status).toBe(410);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it('INVALID code → 400, mints NOTHING', async () => {
    mocks.redeemCode.mockReturnValue({ ok: false, reason: 'invalid' });
    const res = await POST(req({ code: 'ZZZZZZ' }));
    expect(res.status).toBe(400);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it('RATE-LIMITED → 429, mints NOTHING', async () => {
    mocks.redeemCode.mockReturnValue({ ok: false, reason: 'rate_limited' });
    const res = await POST(req({ code: 'ABC234' }));
    expect(res.status).toBe(429);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it('missing code field → 400 validation, redeem never runs', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(mocks.redeemCode).not.toHaveBeenCalled();
    expect(mocks.createToken).not.toHaveBeenCalled();
  });
});
