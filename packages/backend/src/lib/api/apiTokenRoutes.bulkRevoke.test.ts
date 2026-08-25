import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #2608 — the bulk-revoke handler. Two properties are load-bearing and both
 * are asserted here rather than left to the UI:
 *   1. a partial run reports its denominator per token (never swallowed —
 *      that is #2461's bug at N-token scale);
 *   2. the caller's own bridged token is refused, so a cleanup can't end with
 *      the operator logged out mid-list.
 * The token store is mocked so this exercises the handler's rules only.
 */
vi.mock('@/lib/auth/apiTokens', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/apiTokens')>();
  return { ...actual, revokeTokens: vi.fn(), listTokens: vi.fn(), createToken: vi.fn(), revokeToken: vi.fn(), sweepExpiredTokens: vi.fn() };
});

import { bulkRevokeTokensHandler } from './apiTokenRoutes';
import { revokeTokens } from '@/lib/auth/apiTokens';

const mockRevoke = vi.mocked(revokeTokens);

beforeEach(() => vi.clearAllMocks());

const ID = (n: number) => n.toString(16).padStart(8, '0');

describe('bulkRevokeTokensHandler (#2608)', () => {
  it('revokes every id and returns 200 with a full denominator', async () => {
    mockRevoke.mockResolvedValue([
      { id: ID(1), name: 'a', ok: true },
      { id: ID(2), name: 'b', ok: true },
    ]);
    const res = await bulkRevokeTokensHandler({ body: { ids: [ID(1), ID(2)] }, auth: {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ requested: 2, revoked: 2 });
    expect(body.results).toHaveLength(2);
  });

  it('reports a PARTIAL run per token with 207 — three failures are named, not swallowed', async () => {
    mockRevoke.mockResolvedValue([
      { id: ID(1), name: 'a', ok: true },
      { id: ID(2), ok: false, error: 'token not found' },
      { id: ID(3), name: 'c', ok: true },
    ]);
    const res = await bulkRevokeTokensHandler({ body: { ids: [ID(1), ID(2), ID(3)] }, auth: {} });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.requested).toBe(3);
    expect(body.revoked).toBe(2);
    expect(body.results.filter((r: { ok: boolean }) => !r.ok)).toEqual([
      { id: ID(2), ok: false, error: 'token not found' },
    ]);
  });

  it('returns 422 when NOTHING was revoked, so a status-only caller cannot read it as success', async () => {
    mockRevoke.mockResolvedValue([{ id: ID(1), ok: false, error: 'token not found' }]);
    const res = await bulkRevokeTokensHandler({ body: { ids: [ID(1)] }, auth: {} });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ requested: 1, revoked: 0 });
  });

  it('refuses the caller’s own bridged token and never passes it to the store', async () => {
    mockRevoke.mockResolvedValue([{ id: ID(2), name: 'other', ok: true }]);
    const res = await bulkRevokeTokensHandler({
      body: { ids: [ID(1), ID(2)] },
      auth: { viaToken: ID(1) },
    });
    // The other token really was revoked, so this is a partial run.
    expect(res.status).toBe(207);
    expect(mockRevoke).toHaveBeenCalledWith([ID(2)]);
    const body = await res.json();
    expect(body).toMatchObject({ requested: 2, revoked: 1 });
    // Order follows the request, and the refusal explains itself.
    expect(body.results[0].id).toBe(ID(1));
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toMatch(/current session/i);
  });

  it('does not touch the store at all when the only id is the caller’s own token', async () => {
    const res = await bulkRevokeTokensHandler({ body: { ids: [ID(1)] }, auth: { viaToken: ID(1) } });
    expect(res.status).toBe(422);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('rejects a malformed token id with 400 before revoking anything', async () => {
    const res = await bulkRevokeTokensHandler({ body: { ids: [ID(1), '../../etc'] }, auth: {} });
    expect(res.status).toBe(400);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it('deduplicates repeated ids so the denominator matches what was asked for', async () => {
    mockRevoke.mockResolvedValue([{ id: ID(1), name: 'a', ok: true }]);
    const res = await bulkRevokeTokensHandler({ body: { ids: [ID(1), ID(1)] }, auth: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ requested: 1, revoked: 1 });
  });
});
