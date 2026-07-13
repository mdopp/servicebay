/**
 * POST /napi/pair — pairing-code mint, Authelia-session-gated (#2251).
 *
 * Mirrors the token-from-authelia-session privilege-escalation guard (#2249):
 * identity may come ONLY from NPM's proxy-injected forward-auth headers, never
 * from a client Bearer or a caller who set its own Remote-User/Remote-Groups.
 * We drive the ACTUAL route module and assert the spoof paths mint NOTHING.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createPairingCode: vi.fn(),
}));

vi.mock('@/lib/auth/pairingCodes', () => ({
  createPairingCode: mocks.createPairingCode,
}));

import { POST } from './route';

function req(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:5888/napi/pair', { method: 'POST', headers });
}

describe('POST /napi/pair — Authelia-session gate + #2249 spoof-refusal', () => {
  beforeEach(() => {
    mocks.createPairingCode.mockReset();
    mocks.createPairingCode.mockReturnValue({
      code: 'ABC234',
      expiresAt: Date.now() + 5 * 60 * 1000,
      ttlMs: 5 * 60 * 1000,
    });
  });

  it('REFUSES a client Bearer + spoofed Remote-Groups:admins → 403, mints nothing', async () => {
    const res = await POST(
      req({
        authorization: 'Bearer sb_some_scoped_token',
        'remote-user': 'evil',
        'remote-groups': 'admins',
      }),
    );
    expect(res.status).toBe(403);
    expect(mocks.createPairingCode).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.code).toBeUndefined();
  });

  it('mints a code for a real browser forward-auth admin (admin headers, NO Bearer)', async () => {
    const res = await POST(req({ 'remote-user': 'alice', 'remote-groups': 'admins,users' }));
    expect(res.status).toBe(200);
    expect(mocks.createPairingCode).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.code).toBe('ABC234');
    expect(typeof body.qr_url).toBe('string');
    expect(body.qr_url).toContain('/napi/pair/redeem');
    expect(body.qr_url).toContain('ABC234');
    expect(typeof body.expires_at).toBe('string');
  });

  it('forward-auth identity not in admins → 403, mints nothing', async () => {
    const res = await POST(req({ 'remote-user': 'bob', 'remote-groups': 'users' }));
    expect(res.status).toBe(403);
    expect(mocks.createPairingCode).not.toHaveBeenCalled();
  });

  it('no forward-auth identity (spoofable direct call) → 401, mints nothing', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(401);
    expect(mocks.createPairingCode).not.toHaveBeenCalled();
  });
});
