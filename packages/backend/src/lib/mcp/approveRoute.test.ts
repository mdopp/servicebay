/**
 * MCP pending-approval HTTP intercept (#1766) — the LIVE production handler.
 *
 * The Next.js route.ts files are kept as dead code (covered by their own
 * route.test.ts); production actually runs THIS handler, intercepted in
 * server.ts before Next.js sees the request. These tests exercise the live
 * security property end-to-end through the real `pendingApprovals` store:
 *
 *   - Bearer/anon (no session cookie) → 401, and the call NEVER executes —
 *     the proposing agent cannot self-approve.
 *   - a valid cookie session → the pending call executes.
 *   - an expired/unknown handle → 410.
 *   - single-use: a confirmed call can't be replayed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleMcpApproveRequest, isMcpApprovePath } from './approveRoute';
import {
  createPendingApproval,
  __clearPendingApprovalsForTest,
} from './pendingApprovals';

const noSession = async () => null;
const human = async () => ({ user: 'admin', expires: new Date(Date.now() + 60_000) });

beforeEach(() => {
  __clearPendingApprovalsForTest();
});

describe('isMcpApprovePath', () => {
  it('matches the list and the confirm paths, not unrelated paths', () => {
    expect(isMcpApprovePath('/api/system/mcp/approve')).toBe(true);
    expect(isMcpApprovePath('/api/system/mcp/approve/abc')).toBe(true);
    // a trailing slash with no id is not a confirm target
    expect(isMcpApprovePath('/api/system/mcp/approve/')).toBe(false);
    expect(isMcpApprovePath('/api/system/mcp')).toBe(false);
    expect(isMcpApprovePath(undefined)).toBe(false);
  });
});

describe('handleMcpApproveRequest (#1766 security property)', () => {
  it('REJECTS a Bearer/anon caller with 401 and NEVER executes the call', async () => {
    const execute = vi.fn(async () => 'ran');
    const { pendingId } = createPendingApproval({
      toolName: 'destroy_thing',
      args: {},
      caller: 'token:ci-bot',
      execute,
    });

    const res = await handleMcpApproveRequest({
      method: 'POST',
      pathname: `/api/system/mcp/approve/${pendingId}`,
      resolveSession: noSession, // a Bearer/anon request carries no session cookie
    });

    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a logged-in human (cookie session) approves and the call executes', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'deleted' }] }));
    const { pendingId } = createPendingApproval({ toolName: 'destroy_thing', args: {}, execute });

    const res = await handleMcpApproveRequest({
      method: 'POST',
      pathname: `/api/system/mcp/approve/${pendingId}`,
      resolveSession: human,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('an expired / unknown handle returns 410 Gone', async () => {
    const res = await handleMcpApproveRequest({
      method: 'POST',
      pathname: '/api/system/mcp/approve/does-not-exist',
      resolveSession: human,
    });
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ ok: false });
  });

  it('an already-claimed (single-use) handle 410s on a replay', async () => {
    const execute = vi.fn(async () => 'ran');
    const { pendingId } = createPendingApproval({ toolName: 'destroy_thing', args: {}, execute });
    const path = `/api/system/mcp/approve/${pendingId}`;

    const first = await handleMcpApproveRequest({ method: 'POST', pathname: path, resolveSession: human });
    expect(first.status).toBe(200);

    const replay = await handleMcpApproveRequest({ method: 'POST', pathname: path, resolveSession: human });
    expect(replay.status).toBe(410);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('GET lists pending approvals for a cookie session', async () => {
    createPendingApproval({ toolName: 'destroy_thing', args: { id: 1 }, execute: async () => 'x' });
    const res = await handleMcpApproveRequest({
      method: 'GET',
      pathname: '/api/system/mcp/approve',
      resolveSession: human,
    });
    expect(res.status).toBe(200);
    const body = res.body as { pending: Array<{ toolName: string }> };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]!.toolName).toBe('destroy_thing');
  });

  it('GET list still requires a session (Bearer/anon → 401, no leak of pending calls)', async () => {
    createPendingApproval({ toolName: 'destroy_thing', args: {}, execute: async () => 'x' });
    const res = await handleMcpApproveRequest({
      method: 'GET',
      pathname: '/api/system/mcp/approve',
      resolveSession: noSession,
    });
    expect(res.status).toBe(401);
  });

  it('an unsupported method on the confirm path is 405', async () => {
    const res = await handleMcpApproveRequest({
      method: 'DELETE',
      pathname: '/api/system/mcp/approve/abc',
      resolveSession: human,
    });
    expect(res.status).toBe(405);
  });
});
