/**
 * POST /api/auth/token-from-authelia-session — privilege-escalation guard
 * (#2246 / #2249, SECURITY).
 *
 * This endpoint mints a scoped SB-MCP token from a *browser* Authelia session:
 * authority flows from NPM's forward-auth `Remote-User` / `Remote-Groups`
 * headers, which NPM overwrites from the Authelia auth-request subrequest.
 *
 * The box-verify escalation (#2246 RED): on a DIRECT `:5888` call (bypassing
 * NPM), a valid Bearer holder passes proxy.ts's `isValidBearerToken()` gate and
 * can supply its OWN `Remote-User: evil` + `Remote-Groups: admins` headers
 * (nothing upstream overwrote them) → mint an admin-scoped token = self-elevation.
 *
 * The route runs `skipAuth: true`, so the real `withApiHandler` does not gate —
 * we drive the ACTUAL route module and assert:
 *   - a request carrying a client Bearer + spoofed admin headers → 403, NO token
 *   - a legit browser forward-auth request (admin headers, NO Bearer)   → token
 *   - forward-auth headers but not in `admins`                          → 403, NO token
 *   - no forward-auth identity at all                                   → 401, NO token
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  createToken: vi.fn(),
}));

// The route only calls createToken when it decides to mint. If createToken is
// never called on a refused request, no token was minted — the assertion.
vi.mock('@/lib/auth/apiTokens', () => ({
  createToken: mocks.createToken,
}));

import { POST } from './route';

function req(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:5888/api/auth/token-from-authelia-session', {
    method: 'POST',
    headers,
  });
}

describe('token-from-authelia-session privilege-escalation guard (#2249)', () => {
  beforeEach(() => {
    mocks.createToken.mockReset();
    mocks.createToken.mockResolvedValue({
      token: { id: 't1', name: 'authelia-session:admin', scopes: ['read', 'lifecycle', 'mutate'] },
      secret: 'sb_minted_secret',
    });
  });

  it('REFUSES a client Bearer + spoofed Remote-Groups:admins → 403, mints nothing', async () => {
    const res = await POST(
      req({
        authorization: 'Bearer sb_some_scoped_token',
        'remote-user': 'evil-hacker',
        'remote-groups': 'admins',
      }),
    );
    expect(res.status).toBe(403);
    expect(mocks.createToken).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.token).toBeUndefined();
  });

  it('mints for a real browser forward-auth admin session (admin headers, NO Bearer)', async () => {
    const res = await POST(
      req({ 'remote-user': 'alice', 'remote-groups': 'admins,users' }),
    );
    expect(res.status).toBe(200);
    expect(mocks.createToken).toHaveBeenCalledOnce();
    const body = await res.json();
    expect(body.token).toBe('sb_minted_secret');
    expect(body.scopes).toEqual(['read', 'lifecycle', 'mutate']);
  });

  it('forward-auth identity not in admins → 403, mints nothing', async () => {
    const res = await POST(
      req({ 'remote-user': 'bob', 'remote-groups': 'users' }),
    );
    expect(res.status).toBe(403);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });

  it('no forward-auth identity → 401, mints nothing', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(401);
    expect(mocks.createToken).not.toHaveBeenCalled();
  });
});
