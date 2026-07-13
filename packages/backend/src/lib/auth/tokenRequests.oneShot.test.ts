import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';

// #2245 (option b) — one-shot, owner-approved ELEVATED-scope token via the
// request_token/poll_token_request flow. A default-scoped consumer requests a
// token bound to ONE destructive op; it PARKS as a durable approval; on owner
// Approve the poll returns a single-use, short-TTL token carrying ONLY that
// elevated scope; a second use fails. Real-fs DATA_DIR per test.
let dataDir = '';
vi.mock('@/lib/dirs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dirs')>();
  return { ...actual, get DATA_DIR() { return dataDir; } };
});
// submitApproval resolves a target node — stub it so the store doesn't reach a
// real node registry. The executor/ServiceManager are never used by a
// mintToken approval (no move/restart).
vi.mock('@/lib/nodes', () => ({ listNodes: vi.fn(() => Promise.resolve([{ Name: 'box1' }])) }));

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sb-oneshot-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await (await loadTokens()).flushPendingStamps();
  await fsp.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const loadReq = () => import('@/lib/auth/tokenRequests');
const loadTokens = () => import('@/lib/auth/apiTokens');
const loadApprovals = () => import('@/lib/approvals');

describe('one-shot owner-approved elevated token (#2245)', () => {
  it('one-shot request PARKS as an approval and returns an approvalId — mints NOTHING immediately', async () => {
    const { submitTokenRequest, pollTokenRequest } = await loadReq();
    const { listApprovals } = await loadApprovals();
    const { listTokens } = await loadTokens();

    const view = await submitTokenRequest({
      requestedScopes: ['destroy'],
      requestedTtlSecs: 300,
      reason: 'delete honcho',
      requestedBy: 'token:wartung',
      oneShotOp: { toolName: 'delete_service', service: 'honcho' },
    });
    expect(view.status).toBe('pending');
    expect(view.approvalId).toBeTruthy();
    expect((view as Record<string, unknown>).pendingSecret).toBeUndefined();
    expect(view.tokenId).toBeUndefined();

    // A durable approval card exists for the operator.
    const approvals = await listApprovals();
    expect(approvals.map(a => a.id)).toContain(view.approvalId);
    const card = approvals.find(a => a.id === view.approvalId)!;
    expect(card.on_approve.mintToken?.tokenRequestId).toBe(view.id);
    expect(card.payload.caller).toBe('token:wartung'); // self-approve anchor

    // NO token minted yet.
    expect(await listTokens()).toHaveLength(0);
    // Poll before approval → pending, no token.
    const early = await pollTokenRequest(view.id);
    expect(early.status).toBe('pending');
    expect(early.token).toBeNull();
  });

  it('on owner APPROVE, poll returns a single-use token carrying ONLY the bound elevated scope', async () => {
    const { submitTokenRequest, pollTokenRequest } = await loadReq();
    const { approveApproval } = await loadApprovals();
    const { verifyToken } = await loadTokens();

    const view = await submitTokenRequest({
      requestedScopes: ['destroy'], requestedTtlSecs: 300, reason: 'r',
      requestedBy: 'token:wartung', oneShotOp: { toolName: 'delete_service', service: 'honcho' },
    });

    // Owner approves the durable approval → mintToken runs.
    await approveApproval(view.approvalId!);

    const poll = await pollTokenRequest(view.id);
    expect(poll.status).toBe('approved');
    expect(poll.token).toMatch(/^sb_[0-9a-f]{8}_[A-Z2-9]+$/);
    expect((poll as { grantedScopes?: string[] }).grantedScopes).toEqual(['destroy']);

    const verified = await verifyToken(poll.token!);
    expect(verified).not.toBeNull();
    expect(verified!.scopes).toEqual(['destroy']); // ONLY destroy, not read/lifecycle/mutate
    expect(verified!.singleUse).toBe(true);
    expect(verified!.oneShotOp).toEqual({ toolName: 'delete_service', service: 'honcho' });

    // Second poll no longer hands over the secret.
    const again = await pollTokenRequest(view.id);
    expect(again.token).toBeNull();
  });

  it('on owner DENY (reject), NOTHING is minted and poll stays token-less', async () => {
    const { submitTokenRequest, pollTokenRequest } = await loadReq();
    const { rejectApproval } = await loadApprovals();
    const { listTokens } = await loadTokens();

    const view = await submitTokenRequest({
      requestedScopes: ['exec'], requestedTtlSecs: 120, reason: 'r',
      requestedBy: 'token:wartung', oneShotOp: { toolName: 'exec_command' },
    });
    await rejectApproval(view.approvalId!);

    expect(await listTokens()).toHaveLength(0);
    const poll = await pollTokenRequest(view.id);
    // The token request itself never flipped to approved (mint never ran).
    expect(poll.token).toBeNull();
    expect(poll.status).toBe('pending');
  });

  it('single-use burn: consumeSingleUseToken revokes the token so a second verify fails', async () => {
    const { submitTokenRequest, pollTokenRequest } = await loadReq();
    const { approveApproval } = await loadApprovals();
    const { verifyToken, consumeSingleUseToken } = await loadTokens();

    const view = await submitTokenRequest({
      requestedScopes: ['destroy'], requestedTtlSecs: 300, reason: 'r',
      requestedBy: 'token:wartung', oneShotOp: { toolName: 'delete_service', service: 'honcho' },
    });
    await approveApproval(view.approvalId!);
    const secret = (await pollTokenRequest(view.id)).token!;

    const first = await verifyToken(secret);
    expect(first).not.toBeNull();

    // Simulate the gate burning it after the one op.
    const burned = await consumeSingleUseToken(first!.id);
    expect(burned).toBe(true);

    // Second use → token gone → 401 (null).
    expect(await verifyToken(secret)).toBeNull();
  });

  it('consumeSingleUseToken refuses to burn a NON-single-use token (no standing-credential nuke)', async () => {
    const { createToken, consumeSingleUseToken, verifyToken } = await loadTokens();
    const { token, secret } = await createToken({ name: 'standing', scopes: ['read'], createdBy: 'admin' });
    expect(await consumeSingleUseToken(token.id)).toBe(false);
    expect(await verifyToken(secret)).not.toBeNull(); // still alive
  });

  it('TTL is clamped to the one-shot ceiling even if the caller asks for more', async () => {
    const { submitTokenRequest, approveApproval, pollTokenRequest, ONE_SHOT_MAX_TTL_SECS } = {
      ...(await loadReq()), ...(await loadApprovals()),
    } as typeof import('@/lib/auth/tokenRequests') & typeof import('@/lib/approvals');
    const view = await submitTokenRequest({
      requestedScopes: ['destroy'], requestedTtlSecs: 30 * 24 * 3600, reason: 'r',
      requestedBy: 'token:wartung', oneShotOp: { toolName: 'delete_service', service: 'honcho' },
    });
    expect(view.requestedTtlSecs).toBe(ONE_SHOT_MAX_TTL_SECS);
    await approveApproval(view.approvalId!);
    const poll = await pollTokenRequest(view.id);
    expect((poll as { expiresAt?: string }).expiresAt).toBeTruthy();
    const ttlMs = Date.parse((poll as { expiresAt: string }).expiresAt) - Date.now();
    expect(ttlMs).toBeLessThanOrEqual(ONE_SHOT_MAX_TTL_SECS * 1000 + 1000);
  });

  it('rejects a one-shot request that asks for a non-elevated or multi-scope grant', async () => {
    const { submitTokenRequest } = await loadReq();
    await expect(submitTokenRequest({
      requestedScopes: ['read'], requestedTtlSecs: 120, reason: 'r',
      oneShotOp: { toolName: 'delete_service' },
    })).rejects.toThrow(/exactly one elevated scope/);
    await expect(submitTokenRequest({
      requestedScopes: ['destroy', 'exec'], requestedTtlSecs: 120, reason: 'r',
      oneShotOp: { toolName: 'delete_service' },
    })).rejects.toThrow(/exactly one elevated scope/);
  });

  it('mintOneShotForRequest refuses a double-mint (already approved) — no second token', async () => {
    const { submitTokenRequest, mintOneShotForRequest } = await loadReq();
    const { approveApproval } = await loadApprovals();
    const { listTokens } = await loadTokens();
    const view = await submitTokenRequest({
      requestedScopes: ['destroy'], requestedTtlSecs: 300, reason: 'r',
      requestedBy: 'token:wartung', oneShotOp: { toolName: 'delete_service', service: 'honcho' },
    });
    await approveApproval(view.approvalId!);
    expect(await listTokens()).toHaveLength(1);
    // A replayed mint on the same (now-approved) request must throw and mint nothing more.
    await expect(mintOneShotForRequest(view.id)).rejects.toThrow(/already approved/);
    expect(await listTokens()).toHaveLength(1);
  });
});
