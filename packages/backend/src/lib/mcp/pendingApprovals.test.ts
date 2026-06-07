import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createPendingApproval,
  listPendingApprovals,
  getPendingApproval,
  approvePendingApproval,
  ApprovalExpiredError,
  APPROVAL_TTL_MS,
  __clearPendingApprovalsForTest,
} from './pendingApprovals';

describe('pendingApprovals store (#1766)', () => {
  beforeEach(() => {
    __clearPendingApprovalsForTest();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('parks a proposed call and returns a handle without executing it', () => {
    const execute = vi.fn().mockResolvedValue('ran');
    const view = createPendingApproval({
      toolName: 'delete_service',
      args: { name: 'immich' },
      caller: 'token:ci-bot',
      execute,
    });
    expect(view.pendingId).toBeTruthy();
    expect(view.toolName).toBe('delete_service');
    expect(view.args).toEqual({ name: 'immich' });
    expect(view.caller).toBe('token:ci-bot');
    expect(view.expiresAt).toBeGreaterThan(Date.now());
    // Crucially: proposing does NOT run the deferred call.
    expect(execute).not.toHaveBeenCalled();
    // And the handle never leaks the execute thunk to callers.
    expect((view as unknown as Record<string, unknown>).execute).toBeUndefined();
  });

  it('lists pending approvals and looks one up by id (view only, no thunk)', () => {
    const view = createPendingApproval({ toolName: 'factory_reset', args: {}, execute: vi.fn() });
    const list = listPendingApprovals();
    expect(list).toHaveLength(1);
    expect(list[0].pendingId).toBe(view.pendingId);
    expect((list[0] as unknown as Record<string, unknown>).execute).toBeUndefined();
    const got = getPendingApproval(view.pendingId);
    expect(got?.toolName).toBe('factory_reset');
  });

  it('confirm runs the deferred call and returns its result', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const { pendingId } = createPendingApproval({ toolName: 'purge_trashed_service', args: { id: 't1' }, execute });
    const result = await approvePendingApproval(pendingId);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it('is single-use — a second confirm of the same id throws and does not re-run', async () => {
    const execute = vi.fn().mockResolvedValue('ran');
    const { pendingId } = createPendingApproval({ toolName: 'delete_service', args: {}, execute });
    await approvePendingApproval(pendingId);
    await expect(approvePendingApproval(pendingId)).rejects.toBeInstanceOf(ApprovalExpiredError);
    expect(execute).toHaveBeenCalledTimes(1);
    // It is also gone from the listing.
    expect(listPendingApprovals()).toHaveLength(0);
  });

  it('throws ApprovalExpiredError for an unknown id', async () => {
    await expect(approvePendingApproval('does-not-exist')).rejects.toBeInstanceOf(ApprovalExpiredError);
  });

  it('expires a parked call after the TTL — confirm and listing both drop it', async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue('ran');
    const { pendingId } = createPendingApproval({ toolName: 'restore_backup', args: {}, execute });
    expect(listPendingApprovals()).toHaveLength(1);
    // Advance past the TTL.
    vi.advanceTimersByTime(APPROVAL_TTL_MS + 1000);
    expect(listPendingApprovals()).toHaveLength(0);
    await expect(approvePendingApproval(pendingId)).rejects.toBeInstanceOf(ApprovalExpiredError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('honours a custom ttl', () => {
    vi.useFakeTimers();
    const before = Date.now();
    const view = createPendingApproval({ toolName: 'delete_service', args: {}, execute: vi.fn(), ttlMs: 1000 });
    expect(view.expiresAt).toBe(before + 1000);
  });
});
