import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

/**
 * #1275 — `withApiHandler` must:
 *  - skip the gate for an ordinary public GET (no Bearer, no tokenScope),
 *  - run requireSession (and thread the auth payload) when a route opts into
 *    `tokenScope`, so the route can redact for token callers,
 *  - run the gate for ANY Bearer-bearing request — so a Bearer GET to a route
 *    that did NOT opt in still 401s (requireSession ignores Bearer with no
 *    scope and falls through to the absent cookie). This is what preserves the
 *    per-route opt-in invariant once proxy.ts passes valid tokens through.
 */
const requireSessionMock = vi.fn();
vi.mock('@/lib/api/requireSession', () => ({
  requireSession: (...args: unknown[]) => requireSessionMock(...args),
}));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { withApiHandler } from '@/lib/api/handler';

function req(method: string, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/x', { method, headers });
}

describe('withApiHandler token-auth threading (#1275)', () => {
  beforeEach(() => requireSessionMock.mockReset());

  it('GET without Bearer or tokenScope skips the gate; auth is undefined', async () => {
    const handler = withApiHandler({}, async ({ auth }) => ({ sawToken: auth?.user ?? null }));
    const res = await handler(req('GET'));
    expect(requireSessionMock).not.toHaveBeenCalled();
    const json = await res.json();
    expect(json.data.sawToken).toBeNull();
  });

  it('GET with tokenScope runs requireSession and threads the auth payload', async () => {
    requireSessionMock.mockResolvedValue({ user: 'token:tui', scopes: ['read'] });
    let seen: unknown;
    const handler = withApiHandler({ tokenScope: 'read' }, async ({ auth }) => { seen = auth; return {}; });
    await handler(req('GET'));
    expect(requireSessionMock).toHaveBeenCalledOnce();
    expect(requireSessionMock).toHaveBeenCalledWith(expect.anything(), { tokenScope: 'read' });
    expect(seen).toEqual({ user: 'token:tui', scopes: ['read'] });
  });

  it('Bearer GET to a route WITHOUT tokenScope runs the gate and returns its 401', async () => {
    requireSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    );
    const handler = withApiHandler({}, async () => ({ ok: true }));
    const res = await handler(req('GET', { authorization: 'Bearer sb_bad' }));
    expect(requireSessionMock).toHaveBeenCalledOnce();
    expect(res.status).toBe(401);
  });
});

/**
 * #2958 — a scopeless GET now runs the gate whenever a session cookie is
 * present, so that a cookie bridged from a token faces the same scope check its
 * bearer would. That must not turn a *stale* cookie on a public GET into a 401:
 * before #2958 the gate never ran there, and `/api/install/progress` depends on
 * being answered after a clean install invalidates the cookie mid-run (#663).
 */
describe('withApiHandler cookie-borne gate (#2958)', () => {
  beforeEach(() => requireSessionMock.mockReset());

  it('a scopeless GET with a session cookie runs the gate and threads auth', async () => {
    requireSessionMock.mockResolvedValue({ user: 'token:reader', scopes: ['read'] });
    let seen: unknown;
    const handler = withApiHandler({}, async ({ auth }) => { seen = auth; return {}; });
    await handler(req('GET', { cookie: 'session=synthetic' }));
    expect(requireSessionMock).toHaveBeenCalledOnce();
    expect(seen).toEqual({ user: 'token:reader', scopes: ['read'] });
  });

  it('returns the 403 when the classification refuses the cookie principal', async () => {
    requireSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    );
    const handler = withApiHandler({}, async () => ({ ok: true }));
    const res = await handler(req('GET', { cookie: 'session=synthetic' }));
    expect(res.status).toBe(403);
  });

  it('a stale cookie on a scopeless GET stays anonymous rather than becoming a 401', async () => {
    requireSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    );
    const handler = withApiHandler({}, async ({ auth }) => ({ sawToken: auth?.user ?? null }));
    const res = await handler(req('GET', { cookie: 'session=stale' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.sawToken).toBeNull();
  });

  it('a stale cookie on a MUTATING route is still a 401', async () => {
    requireSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    );
    const handler = withApiHandler({}, async () => ({ ok: true }));
    expect((await handler(req('POST', { cookie: 'session=stale' }))).status).toBe(401);
  });

  it('a stale cookie on a route that declares a scope is still a 401', async () => {
    requireSessionMock.mockResolvedValue(
      NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
    );
    const handler = withApiHandler({ cookieScope: 'read' }, async () => ({ ok: true }));
    expect((await handler(req('GET', { cookie: 'session=stale' }))).status).toBe(401);
  });

  it('a cookie-less public GET still skips the gate entirely', async () => {
    const handler = withApiHandler({}, async () => ({ ok: true }));
    expect((await handler(req('GET'))).status).toBe(200);
    expect(requireSessionMock).not.toHaveBeenCalled();
  });
});
