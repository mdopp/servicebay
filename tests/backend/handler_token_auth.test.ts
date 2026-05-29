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
