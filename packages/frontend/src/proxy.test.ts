/**
 * proxy.ts CSRF/auth gate — the #2278 server-to-server mint path.
 *
 * The two `*-from-authelia-session` mint routes (#2246/#2276) are `skipAuth:true`
 * and expect a forward-auth-header-only POST (NPM-injected Remote-User/
 * Remote-Groups, NO Bearer, NO Origin). Before #2278 that shape was 403'd by
 * proxy.ts's CSRF guard BEFORE the handler ran: not isInternalCall, not a valid
 * Bearer, not same-origin → 403 "cross-site request". The fix makes NPM inject
 * `X-SB-Internal-Token` on the mint location, so a request through NPM carries
 * the token and passes `isInternalCall` (proxy.ts:187) → reaches the handler.
 *
 * These tests assert the proxy-LAYER security invariants of that path:
 *   (a) a POST with a VALID X-SB-Internal-Token (the NPM-fronted shape) crosses
 *       the CSRF gate — no Origin, no Bearer needed;
 *   (b) a DIRECT :5888 POST forging Remote-User/Remote-Groups:admins WITHOUT the
 *       internal token and WITHOUT an Origin is REJECTED (403 CSRF) — a LAN
 *       attacker forging Remote-* can NEVER reach the mint. Trust flows only
 *       from NPM's position (the injected token), never from client headers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

process.env.AUTH_SECRET = 'test-auth-secret-for-2278-proxy';

// Config/domain reads must not touch disk; the mint paths are /api/* so the
// apex-portal rewrite branch is never reached, but stub them defensively.
vi.mock('@/lib/config', () => ({ getConfig: vi.fn(() => Promise.resolve({})) }));
vi.mock('@/lib/mode', () => ({ getActiveDomain: vi.fn(() => '') }));
vi.mock('@/lib/auth/session', () => ({ decrypt: vi.fn(() => Promise.resolve(null)) }));
// No Bearer is valid in these tests (the forged/token-less shapes) — a real
// token verify would hit the token store; stub it to "invalid".
vi.mock('@/lib/auth/apiTokens', () => ({ verifyToken: vi.fn(() => Promise.resolve(null)) }));

import { proxy } from './proxy';
import { getInternalApiToken } from '@/lib/auth/internalToken';

const MINT_URL = 'http://localhost:5888/api/auth/delegated-admin-from-authelia-session';

function post(headers: Record<string, string>): NextRequest {
  return new NextRequest(MINT_URL, { method: 'POST', headers });
}

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-auth-secret-for-2278-proxy';
});

describe('proxy.ts — #2278 mint server-to-server gate', () => {
  it('(a) a POST with a valid X-SB-Internal-Token + Remote-* (NPM-fronted shape) crosses the CSRF gate — no Origin, no Bearer', async () => {
    const res = await proxy(
      post({
        'x-sb-internal-token': getInternalApiToken(),
        'remote-user': 'alice',
        'remote-groups': 'admins',
      }),
    );
    // NextResponse.next() carries the passthrough header and no 403 body.
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('(b) a DIRECT :5888 POST forging Remote-User/Remote-Groups:admins WITHOUT the internal token and WITHOUT Origin → 403 CSRF (never reaches the mint)', async () => {
    const res = await proxy(
      post({
        // Attacker forges the forward-auth identity but has NO internal token
        // (NPM never fronted this) and NO Origin (server-to-server).
        'remote-user': 'evil',
        'remote-groups': 'admins',
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/cross-site/i);
  });

  it('(b′) a wrong/garbage X-SB-Internal-Token does not cross the gate (constant-length compare) → 403', async () => {
    const res = await proxy(
      post({
        'x-sb-internal-token': 'not-the-real-token',
        'remote-user': 'evil',
        'remote-groups': 'admins',
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/cross-site/i);
  });
});
