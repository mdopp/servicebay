import { describe, it, expect, vi, beforeEach } from 'vitest';

// #2299 — the createTokenHandler must fail-closed 403 when a `neverExpires`
// token requests any non-read scope, and pass `neverExpires` through otherwise.
// requireSession + the mint + the bootstrap-revoke are mocked so this exercises
// only the guard + wiring.
vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'admin' })),
}));
vi.mock('@/lib/auth/apiTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/apiTokens')>();
  return {
    ...actual,
    createToken: vi.fn(async () => ({ token: { id: 'aabbccdd' }, secret: 'sb_aabbccdd_SECRET' })),
    createDelegatedToken: vi.fn(),
    revokeToken: vi.fn(),
    listTokens: vi.fn(),
  };
});
vi.mock('@/lib/mcp/bootstrapToken', () => ({
  revokeBootstrapToken: vi.fn(async () => {}),
}));

import { createTokenHandler } from './apiTokenRoutes';
import { createToken } from '@/lib/auth/apiTokens';

const mkRequest = (body: unknown) =>
  new Request('http://test/api/system/api-tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createTokenHandler neverExpires guard (#2299)', () => {
  it('mints a read-only + neverExpires token and passes neverExpires through', async () => {
    const res = await createTokenHandler({ request: mkRequest({ name: 'machine', scopes: ['read'], neverExpires: true }) });
    expect(res.status).toBe(200);
    expect(createToken).toHaveBeenCalledWith(expect.objectContaining({ neverExpires: true, scopes: ['read'] }));
  });

  it('rejects neverExpires + a non-read scope with 403 and does NOT mint', async () => {
    const res = await createTokenHandler({ request: mkRequest({ name: 'machine', scopes: ['read', 'mutate'], neverExpires: true }) });
    expect(res.status).toBe(403);
    expect(createToken).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toMatch(/never-expiring/i);
  });

  it('rejects neverExpires with a lone non-read scope (403)', async () => {
    const res = await createTokenHandler({ request: mkRequest({ name: 'machine', scopes: ['destroy'], neverExpires: true }) });
    expect(res.status).toBe(403);
    expect(createToken).not.toHaveBeenCalled();
  });

  it('allows a non-read scope when neverExpires is absent (default false)', async () => {
    const res = await createTokenHandler({ request: mkRequest({ name: 'ops', scopes: ['read', 'mutate'] }) });
    expect(res.status).toBe(200);
    expect(createToken).toHaveBeenCalledWith(expect.objectContaining({ neverExpires: false }));
  });
});
