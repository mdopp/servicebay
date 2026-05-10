import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth/session', () => ({
  getSessionFromCookieHeader: vi.fn(),
}));
vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: vi.fn(() => 'test-internal-token-32-chars-long'),
}));

import { requireSession } from './requireSession';
import { getSessionFromCookieHeader } from '@/lib/auth/session';

beforeEach(() => {
  (getSessionFromCookieHeader as unknown as { mockReset: () => void }).mockReset();
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
});
