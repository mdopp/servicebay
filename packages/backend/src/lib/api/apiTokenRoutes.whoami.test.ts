import { describe, it, expect, vi, beforeEach } from 'vitest';

// #2984 — `servicebay whoami`. The handler is the one place an agent can ask
// what its token may do, so the thing worth pinning is the SHAPE of the answer:
// every field the CLI reads, and nothing secret. `verifyToken` is mocked so this
// exercises only the handler's own three branches — no bearer, a bearer the
// store does not know, a bearer it does — not the store.
vi.mock('@/lib/auth/apiTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/apiTokens')>();
  return {
    ...actual,
    verifyToken: vi.fn(),
  };
});
vi.mock('@/lib/mcp/bootstrapToken', () => ({
  revokeBootstrapToken: vi.fn(async () => {}),
}));

import { whoamiHandler } from './apiTokenRoutes';
import { verifyToken } from '@/lib/auth/apiTokens';

const mockVerify = vi.mocked(verifyToken);

const mkRequest = (authorization?: string) =>
  new Request('http://test/api/system/api-tokens/me', {
    method: 'GET',
    headers: authorization ? { authorization } : {},
  });

/** What the store hands back: the public view of a record, hash already gone. */
const RECORD = {
  id: '70ac5e83',
  name: 'pi-web (PI_WEB_SB_TOKEN)',
  scopes: ['read', 'propose', 'lifecycle', 'mutate'] as const,
  prefix: 'sb_7',
  createdAt: '2026-09-08T20:19:00.000Z',
  createdBy: 'admin',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('whoamiHandler (#2984)', () => {
  it('refuses a request with no Bearer without consulting the store', async () => {
    const res = await whoamiHandler({ request: mkRequest() });
    expect(res.status).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('refuses a Bearer the store does not know — unknown, revoked or expired all look the same', async () => {
    mockVerify.mockResolvedValueOnce(null);
    const res = await whoamiHandler({ request: mkRequest('Bearer sb_deadbeef_not-a-real-secret') });
    expect(res.status).toBe(401);
    expect(mockVerify).toHaveBeenCalledWith('sb_deadbeef_not-a-real-secret');
  });

  it('answers a known token with exactly what the CLI reads, and nothing secret', async () => {
    mockVerify.mockResolvedValueOnce({ ...RECORD, scopes: [...RECORD.scopes] });
    const res = await whoamiHandler({ request: mkRequest('Bearer sb_70ac5e83_also-not-real') });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: '70ac5e83',
      name: 'pi-web (PI_WEB_SB_TOKEN)',
      scopes: ['read', 'propose', 'lifecycle', 'mutate'],
      createdAt: '2026-09-08T20:19:00.000Z',
      expiresAt: null,
      parentId: null,
    });
    // The record carries a prefix and a creator; neither is the caller's business,
    // and the hash never even reaches this handler. Pin the absence, not just the
    // presence — a later `...token` spread would pass every other assertion here.
    expect(Object.keys(body).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'name', 'parentId', 'scopes']);
  });

  it('shows a delegated child its parent and its expiry', async () => {
    mockVerify.mockResolvedValueOnce({
      ...RECORD,
      id: '266878fd',
      name: 'asteroids-bubblegum',
      scopes: ['read', 'propose'],
      parentId: '70ac5e83',
      expiresAt: '2026-10-20T00:00:00.000Z',
    });
    const res = await whoamiHandler({ request: mkRequest('Bearer sb_266878fd_child') });
    const body = await res.json();
    expect(body).toMatchObject({ id: '266878fd', parentId: '70ac5e83', expiresAt: '2026-10-20T00:00:00.000Z' });
  });
});
