import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSessionFromCookieHeader: vi.fn(),
}));
vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: vi.fn(() => 'test-internal-token-32-chars-long'),
}));
vi.mock('@/lib/mcp/tokens', () => ({
  verifyToken: vi.fn(),
}));

import { requireSession } from './requireSession';
import { getSessionFromCookieHeader } from '@/lib/auth/session';
import { verifyToken } from '@/lib/mcp/tokens';

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
      expect((result as NextResponse).status).toBe(401);
    });

    it('rejects an invalid/expired Bearer token (verifyToken null)', async () => {
      mockVerify.mockResolvedValueOnce(null);
      const result = await requireSession(
        mkRequest({ authorization: 'Bearer sb_deadbeef_NOPE' }),
        { tokenScope: 'read' },
      );
      expect(result instanceof NextResponse).toBe(true);
    });

    it('ignores a Bearer token entirely when the route does not opt in (no tokenScope)', async () => {
      mockCookie.mockResolvedValueOnce(null);
      const result = await requireSession(mkRequest({ authorization: 'Bearer sb_a1b2c3d4_SECRET' }));
      expect(result instanceof NextResponse).toBe(true);
      // The token machinery is never consulted on non-opted-in routes.
      expect(mockVerify.mock.calls).toHaveLength(0);
    });
  });
});
