import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// #2139 — MCP scoped, admin-approved, self-expiring token request flow.
// Full lifecycle: request → approve-with-narrowed-scopes → poll (collect once)
// → use (verify) → expire → sweep. Real-fs DATA_DIR per test.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-tokreq-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await (await loadTokens()).flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const loadReq = () => import('@/lib/auth/tokenRequests');
const loadTokens = () => import('@/lib/auth/apiTokens');

describe('token request flow (#2139)', () => {
  it('request returns a pending id and NO token', async () => {
    const { submitTokenRequest, listTokenRequests } = await loadReq();
    const view = await submitTokenRequest({
      requestedScopes: ['read', 'lifecycle'], requestedTtlSecs: 3600, reason: 'deploy one service', requestedBy: 'agent:x',
    });
    expect(view.status).toBe('pending');
    expect(view.id).toBeTruthy();
    expect((view as Record<string, unknown>).pendingSecret).toBeUndefined();
    expect((view as Record<string, unknown>).tokenId).toBeUndefined();

    const pending = await listTokenRequests('pending');
    expect(pending.map(r => r.id)).toContain(view.id);
    expect(pending[0].requestedBy).toBe('agent:x');
  });

  it('approve narrows scopes (least privilege), poll returns a usable token', async () => {
    const { submitTokenRequest, approveTokenRequest, pollTokenRequest } = await loadReq();
    const { verifyToken } = await loadTokens();

    const req = await submitTokenRequest({ requestedScopes: ['read', 'lifecycle', 'mutate'], requestedTtlSecs: 3600, reason: 'r' });

    // Admin grants FEWER scopes than requested + a shorter TTL.
    const approved = await approveTokenRequest(req.id, { scopes: ['read'], ttlSecs: 600, approvedBy: 'admin1' });
    expect(approved.status).toBe('approved');
    expect(approved.grantedScopes).toEqual(['read']);
    expect(approved.grantedTtlSecs).toBe(600);
    expect(approved.tokenId).toBeTruthy();

    // First poll hands over the secret exactly once.
    const first = await pollTokenRequest(req.id);
    expect(first.status).toBe('approved');
    expect(first.token).toMatch(/^sb_[0-9a-f]{8}_[A-Z2-9]+$/);
    expect((first as { grantedScopes?: string[] }).grantedScopes).toEqual(['read']);

    // The minted token authenticates and carries only the granted scope.
    const verified = await verifyToken(first.token!);
    expect(verified).not.toBeNull();
    expect(verified!.scopes).toEqual(['read']);

    // Second poll no longer returns the secret (single hand-off).
    const second = await pollTokenRequest(req.id);
    expect(second.status).toBe('approved');
    expect(second.token).toBeNull();
  });

  it('rejects an approval that widens beyond the requested scopes', async () => {
    const { submitTokenRequest, approveTokenRequest, TokenRequestError } = await loadReq();
    const req = await submitTokenRequest({ requestedScopes: ['read'], requestedTtlSecs: 60, reason: 'r' });
    await expect(approveTokenRequest(req.id, { scopes: ['read', 'exec'] })).rejects.toBeInstanceOf(TokenRequestError);
  });

  it('denied request yields no token', async () => {
    const { submitTokenRequest, denyTokenRequest, pollTokenRequest } = await loadReq();
    const req = await submitTokenRequest({ requestedScopes: ['read'], requestedTtlSecs: 60, reason: 'r' });
    const denied = await denyTokenRequest(req.id);
    expect(denied.status).toBe('denied');
    const polled = await pollTokenRequest(req.id);
    expect(polled.status).toBe('denied');
    expect(polled.token).toBeNull();
  });

  it('re-resolving an already-resolved request throws 409', async () => {
    const { submitTokenRequest, approveTokenRequest, denyTokenRequest, TokenRequestError } = await loadReq();
    const req = await submitTokenRequest({ requestedScopes: ['read'], requestedTtlSecs: 60, reason: 'r' });
    await approveTokenRequest(req.id);
    await expect(denyTokenRequest(req.id)).rejects.toMatchObject({ status: 409 });
    await expect(approveTokenRequest(req.id)).rejects.toBeInstanceOf(TokenRequestError);
  });

  it('poll of an unknown id → not-found', async () => {
    const { pollTokenRequest } = await loadReq();
    const res = await pollTokenRequest('nope');
    expect(res.status).toBe('not-found');
    expect(res.token).toBeNull();
  });

  it('rejects a TTL over the ceiling and an empty scope set', async () => {
    const { submitTokenRequest, MAX_TTL_SECS, TokenRequestError } = await loadReq();
    await expect(submitTokenRequest({ requestedScopes: ['read'], requestedTtlSecs: MAX_TTL_SECS + 1, reason: 'r' }))
      .rejects.toBeInstanceOf(TokenRequestError);
    await expect(submitTokenRequest({ requestedScopes: [], requestedTtlSecs: 60, reason: 'r' }))
      .rejects.toBeInstanceOf(TokenRequestError);
    await expect(submitTokenRequest({ requestedScopes: ['read'], requestedTtlSecs: 60, reason: '  ' }))
      .rejects.toBeInstanceOf(TokenRequestError);
  });

  it('full lifecycle: expired granted token is rejected AND swept from storage', async () => {
    const { submitTokenRequest, approveTokenRequest, pollTokenRequest } = await loadReq();
    const { verifyToken, sweepExpiredTokens, listTokens } = await loadTokens();

    const req = await submitTokenRequest({ requestedScopes: ['read', 'lifecycle'], requestedTtlSecs: 1, reason: 'short' });
    const approved = await approveTokenRequest(req.id, { ttlSecs: 1 });
    const tokenId = approved.tokenId!;

    const first = await pollTokenRequest(req.id);
    const secret = first.token!;
    expect(secret).toBeTruthy();

    // Fake time forward past the 1s TTL.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5000));

    // Expired → verify rejects it.
    expect(await verifyToken(secret)).toBeNull();

    // ...and the sweeper deletes the dead row from api-tokens.json.
    const swept = await sweepExpiredTokens();
    expect(swept).toContain(tokenId);
    const remaining = (await listTokens()).map(t => t.id);
    expect(remaining).not.toContain(tokenId);

    vi.useRealTimers();
  });

  it('a grant that expired before its first poll is not handed out', async () => {
    const { submitTokenRequest, approveTokenRequest, pollTokenRequest } = await loadReq();
    const req = await submitTokenRequest({ requestedScopes: ['read'], requestedTtlSecs: 1, reason: 'r' });
    await approveTokenRequest(req.id, { ttlSecs: 1 });

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 5000));
    const polled = await pollTokenRequest(req.id);
    // Approved but the credential is already dead → no token returned.
    expect(polled.status).toBe('approved');
    expect(polled.token).toBeNull();
    vi.useRealTimers();
  });
});
