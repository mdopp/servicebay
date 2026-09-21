import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSessionFromCookieHeader: vi.fn(),
}));
vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: vi.fn(() => 'test-internal-token-32-chars-long'),
}));
vi.mock('@/lib/auth/apiTokens', () => ({
  verifyToken: vi.fn(),
  tokenIsLive: vi.fn(async () => true),
}));

import { requireSession } from './requireSession';
import { getSessionFromCookieHeader } from '@/lib/auth/session';
import { verifyToken } from '@/lib/auth/apiTokens';

const mockCookie = getSessionFromCookieHeader as unknown as {
  mockReset: () => void;
  mockResolvedValueOnce: (v: unknown) => void;
};
const mockVerify = verifyToken as unknown as {
  mockReset: () => void;
  mockResolvedValueOnce: (v: unknown) => void;
  mock: { calls: unknown[] };
};

beforeEach(() => {
  mockCookie.mockReset();
  mockVerify.mockReset();
});

const mkRequest = (headers: Record<string, string>) =>
  new Request('http://test/', { headers });

describe('requireSession', () => {
  it('accepts a valid session cookie', async () => {
    (getSessionFromCookieHeader as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce({ user: 'admin', expires: new Date(Date.now() + 60_000) });
    const result = await requireSession(mkRequest({ cookie: 'session=abc' }));
    expect(result instanceof NextResponse).toBe(false);
    expect((result as { user: string }).user).toBe('admin');
  });

  it('rejects when no cookie and no token', async () => {
    (getSessionFromCookieHeader as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce(null);
    const result = await requireSession(mkRequest({}));
    expect(result instanceof NextResponse).toBe(true);
    expect((result as NextResponse).status).toBe(401);
  });

  it('accepts the X-SB-Internal-Token header (post-deploy script path)', async () => {
    const result = await requireSession(mkRequest({
      'x-sb-internal-token': 'test-internal-token-32-chars-long',
    }));
    expect(result instanceof NextResponse).toBe(false);
    expect((result as { user: string }).user).toBe('internal');
  });

  it('rejects an invalid X-SB-Internal-Token (wrong value, same length)', async () => {
    (getSessionFromCookieHeader as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce(null);
    const result = await requireSession(mkRequest({
      'x-sb-internal-token': 'wrong-token-but-correct-length-x',
    }));
    expect(result instanceof NextResponse).toBe(true);
  });

  it('rejects a wrong-length internal token without comparing bytes (length mismatch is cheap)', async () => {
    (getSessionFromCookieHeader as unknown as { mockResolvedValueOnce: (v: unknown) => void })
      .mockResolvedValueOnce(null);
    const result = await requireSession(mkRequest({
      'x-sb-internal-token': 'too-short',
    }));
    expect(result instanceof NextResponse).toBe(true);
  });

  describe('named API token (Bearer) — #1264', () => {
    it('accepts a Bearer token that carries the required scope', async () => {
      mockVerify.mockResolvedValueOnce({ id: 'a1b2c3d4', name: 'tui', scopes: ['read', 'mutate'] });
      const result = await requireSession(
        mkRequest({ authorization: 'Bearer sb_a1b2c3d4_SECRET' }),
        { tokenScope: 'mutate' },
      );
      expect(result instanceof NextResponse).toBe(false);
      expect((result as { user: string }).user).toBe('token:tui');
      expect((result as { scopes?: string[] }).scopes).toEqual(['read', 'mutate']);
    });

    it('rejects a Bearer token lacking the required scope — no cookie fall-through', async () => {
      mockVerify.mockResolvedValueOnce({ id: 'a1b2c3d4', name: 'tui', scopes: ['read'] });
      // A valid cookie is present, but a rejected Bearer must NOT fall through to it.
      mockCookie.mockResolvedValueOnce({ user: 'admin', expires: new Date(Date.now() + 60_000) });
      const result = await requireSession(
        mkRequest({ authorization: 'Bearer sb_a1b2c3d4_SECRET' }),
        { tokenScope: 'mutate' },
      );
      expect(result instanceof NextResponse).toBe(true);
      // #3001: authenticated but under-scoped is a 403 that NAMES the tier, not
      // the flat 401 an unknown token gets. The difference is the whole of what
      // a refused agent can act on.
      expect((result as NextResponse).status).toBe(403);
      expect(await (result as NextResponse).json()).toEqual({ error: "Forbidden: 'mutate' scope required" });
    });

    it('answers a Bearer and a bridged cookie from the SAME token identically (#3001)', async () => {
      // One question, one answer. Before #3001 the Bearer got 401 and the
      // cookie minted from that very token got 403 with the tier named.
      const scopes = ['read'];
      mockVerify.mockResolvedValueOnce({ id: 'a1b2c3d4', name: 'pi-web', scopes });
      const viaBearer = await requireSession(
        mkRequest({ authorization: 'Bearer sb_a1b2c3d4_SECRET' }),
        { tokenScope: 'lifecycle' },
      ) as NextResponse;
      mockCookie.mockResolvedValueOnce({ user: 'token:pi-web', expires: new Date(Date.now() + 60_000), scopes });
      const viaCookie = await requireSession(
        mkRequest({ cookie: 'session=bridged' }),
        { tokenScope: 'lifecycle' },
      ) as NextResponse;

      expect(viaBearer.status).toBe(viaCookie.status);
      expect(await viaBearer.json()).toEqual(await viaCookie.json());
    });

    it('rejects an invalid/expired Bearer token (verifyToken null)', async () => {
      mockVerify.mockResolvedValueOnce(null);
      const result = await requireSession(
        mkRequest({ authorization: 'Bearer sb_deadbeef_NOPE' }),
        { tokenScope: 'read' },
      );
      expect(result instanceof NextResponse).toBe(true);
    });

    it('tells an UNVERIFIED token nothing about the route it was refused from (#3001)', async () => {
      // The other half of the split. A credential that does not verify has no
      // claim to learn which tier the route wanted — that would turn a flat
      // 401 into a scope-map oracle for anyone holding a revoked token.
      mockVerify.mockResolvedValueOnce(null);
      mockCookie.mockResolvedValueOnce(null);
      const result = await requireSession(
        mkRequest({ authorization: 'Bearer sb_deadbeef_NOPE' }),
        { tokenScope: 'destroy' },
      ) as NextResponse;
      expect(result.status).toBe(401);
      const body = await result.json();
      expect(body).toEqual({ error: 'Authentication required' });
      expect(JSON.stringify(body)).not.toContain('destroy');
    });

    it('ignores a Bearer token entirely when the route does not opt in (no tokenScope)', async () => {
      mockCookie.mockResolvedValueOnce(null);
      const result = await requireSession(mkRequest({ authorization: 'Bearer sb_a1b2c3d4_SECRET' }));
      expect(result instanceof NextResponse).toBe(true);
      // The token machinery is never consulted on non-opted-in routes.
      expect(mockVerify.mock.calls).toHaveLength(0);
    });
  });

  // A cookie minted by /api/auth/session-from-token carries the source token's
  // `scopes`. The cookie branch must hold it to them, exactly like the Bearer
  // branch — the gap #2768 closed. (End-to-end, through the real bridge route
  // and real session crypto:
  // packages/frontend/src/app/api/auth/session-from-token/route.test.ts.)
  describe('scoped cookie session (token→session bridge) — #2768', () => {
    it('rejects a read-only bridged cookie on a tokenScope:destroy route with 403', async () => {
      mockCookie.mockResolvedValueOnce({
        user: 'token:readonly',
        expires: new Date(Date.now() + 60_000),
        scopes: ['read'],
        viaToken: 'a1b2c3d4',
      });
      const result = await requireSession(mkRequest({ cookie: 'session=abc' }), {
        tokenScope: 'destroy',
      });
      expect(result instanceof NextResponse).toBe(true);
      expect((result as NextResponse).status).toBe(403);
    });

    it('admits a bridged cookie on a route whose scope it holds', async () => {
      mockCookie.mockResolvedValueOnce({
        user: 'token:readonly',
        expires: new Date(Date.now() + 60_000),
        scopes: ['read'],
        viaToken: 'a1b2c3d4',
      });
      const result = await requireSession(mkRequest({ cookie: 'session=abc' }), {
        tokenScope: 'read',
      });
      expect(result instanceof NextResponse).toBe(false);
    });

    it('honours destroy ⇒ reboot for a bridged cookie (one surviving implication)', async () => {
      mockCookie.mockResolvedValueOnce({
        user: 'token:ops',
        expires: new Date(Date.now() + 60_000),
        scopes: ['destroy'],
        viaToken: 'a1b2c3d4',
      });
      const result = await requireSession(mkRequest({ cookie: 'session=abc' }), {
        tokenScope: 'reboot',
      });
      expect(result instanceof NextResponse).toBe(false);
    });

    it('leaves a scope-less cookie (password login) unrestricted — back-compat', async () => {
      mockCookie.mockResolvedValueOnce({ user: 'admin', expires: new Date(Date.now() + 60_000) });
      const result = await requireSession(mkRequest({ cookie: 'session=abc' }), {
        tokenScope: 'destroy',
      });
      expect(result instanceof NextResponse).toBe(false);
      expect((result as { user: string }).user).toBe('admin');
    });
  });
});
