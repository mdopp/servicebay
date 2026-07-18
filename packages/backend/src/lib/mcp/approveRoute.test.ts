/**
 * MCP pending-approval HTTP intercept (#1766, #2234) — the LIVE production handler.
 *
 * The intercept is a cookie-gated adapter over the durable `lib/approvals`
 * store: it lists / approves / rejects the MCP-kind approvals (those carrying
 * an `on_approve.mcp` action) that a token agent proposed but cannot run. These
 * tests exercise the security + routing property with the approvals store
 * mocked:
 *
 *   - Bearer/anon (no session cookie) → 401, and neither approve nor reject is
 *     reached — the proposing agent cannot self-approve.
 *   - a valid cookie session → GET lists, POST approves, DELETE rejects.
 *   - a non-MCP or unknown id → 410 (not owned by this surface).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleMcpApproveRequest, isMcpApprovePath } from './approveRoute';

const listApprovals = vi.fn();
const getApproval = vi.fn();
const approveApproval = vi.fn();
const rejectApproval = vi.fn();
vi.mock('@/lib/approvals', () => ({
  listApprovals: (...a: unknown[]) => listApprovals(...a),
  getApproval: (...a: unknown[]) => getApproval(...a),
  approveApproval: (...a: unknown[]) => approveApproval(...a),
  rejectApproval: (...a: unknown[]) => rejectApproval(...a),
}));

const noSession = async () => null;
const human = async () => ({ user: 'admin', expires: new Date(Date.now() + 60_000) });

function mcpApproval(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    service: 'media',
    title: 'delete_service: media',
    description: null,
    payload: { toolName: 'delete_service', args: { name: 'media' }, caller: 'token:ci-bot' },
    on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
    on_reject: {},
    node: 'Local',
    created_at: new Date().toISOString(),
    status: 'pending',
    ...extra,
  };
}

beforeEach(() => {
  listApprovals.mockReset();
  getApproval.mockReset();
  approveApproval.mockReset();
  rejectApproval.mockReset();
});

describe('isMcpApprovePath', () => {
  it('matches the list and the confirm paths, not unrelated paths', () => {
    expect(isMcpApprovePath('/api/system/mcp/approve')).toBe(true);
    expect(isMcpApprovePath('/api/system/mcp/approve/abc')).toBe(true);
    expect(isMcpApprovePath('/api/system/mcp/approve/')).toBe(false);
    expect(isMcpApprovePath('/api/system/mcp')).toBe(false);
    expect(isMcpApprovePath(undefined)).toBe(false);
  });
});

describe('handleMcpApproveRequest (#1766/#2234 security property)', () => {
  it('REJECTS a Bearer/anon caller with 401 and NEVER approves', async () => {
    const res = await handleMcpApproveRequest({
      method: 'POST',
      pathname: '/api/system/mcp/approve/appr-1',
      resolveSession: noSession, // a Bearer/anon request carries no session cookie
    });
    expect(res.status).toBe(401);
    expect(approveApproval).not.toHaveBeenCalled();
  });

  it('GET list still requires a session (Bearer/anon → 401)', async () => {
    const res = await handleMcpApproveRequest({
      method: 'GET',
      pathname: '/api/system/mcp/approve',
      resolveSession: noSession,
    });
    expect(res.status).toBe(401);
    expect(listApprovals).not.toHaveBeenCalled();
  });

  it('GET lists ONLY pending MCP-kind approvals, in the legacy view shape', async () => {
    listApprovals.mockResolvedValue([
      mcpApproval('appr-1'),
      // a move/restart approval — belongs to /api/approvals, filtered out here.
      { ...mcpApproval('move-1'), on_approve: { move: { src: '/a', dst: '/b' } } },
      // an already-approved MCP one — not pending, filtered out.
      mcpApproval('done-1', { status: 'approved' }),
    ]);
    const res = await handleMcpApproveRequest({
      method: 'GET',
      pathname: '/api/system/mcp/approve',
      resolveSession: human,
    });
    expect(res.status).toBe(200);
    const body = res.body as { pending: Array<{ pendingId: string; toolName: string; expiresAt: number | null }> };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]).toMatchObject({ pendingId: 'appr-1', toolName: 'delete_service', expiresAt: null });
  });

  it('a logged-in human POST approves the MCP approval (runs the tool)', async () => {
    getApproval.mockResolvedValue(mcpApproval('appr-1'));
    approveApproval.mockResolvedValue({ request: mcpApproval('appr-1', { status: 'approved' }) });
    const res = await handleMcpApproveRequest({
      method: 'POST',
      pathname: '/api/system/mcp/approve/appr-1',
      resolveSession: human,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(approveApproval).toHaveBeenCalledWith('appr-1');
  });

  it('a logged-in human DELETE rejects the MCP approval (cancels, no tool run)', async () => {
    getApproval.mockResolvedValue(mcpApproval('appr-1'));
    rejectApproval.mockResolvedValue({ request: mcpApproval('appr-1', { status: 'rejected' }) });
    const res = await handleMcpApproveRequest({
      method: 'DELETE',
      pathname: '/api/system/mcp/approve/appr-1',
      resolveSession: human,
    });
    expect(res.status).toBe(200);
    expect(rejectApproval).toHaveBeenCalledWith('appr-1');
    expect(approveApproval).not.toHaveBeenCalled();
  });

  it('an unknown id 410s', async () => {
    getApproval.mockResolvedValue(null);
    const res = await handleMcpApproveRequest({
      method: 'POST',
      pathname: '/api/system/mcp/approve/nope',
      resolveSession: human,
    });
    expect(res.status).toBe(410);
    expect(approveApproval).not.toHaveBeenCalled();
  });

  it('a non-MCP approval (move/restart) is NOT actionable through this surface (410)', async () => {
    getApproval.mockResolvedValue({ ...mcpApproval('move-1'), on_approve: { move: { src: '/a', dst: '/b' } } });
    const res = await handleMcpApproveRequest({
      method: 'POST',
      pathname: '/api/system/mcp/approve/move-1',
      resolveSession: human,
    });
    expect(res.status).toBe(410);
    expect(approveApproval).not.toHaveBeenCalled();
  });

  it('an already-resolved request 410s on approve', async () => {
    getApproval.mockResolvedValue(mcpApproval('appr-1'));
    approveApproval.mockRejectedValue(new Error('Approval request appr-1 is already approved'));
    const res = await handleMcpApproveRequest({
      method: 'POST',
      pathname: '/api/system/mcp/approve/appr-1',
      resolveSession: human,
    });
    expect(res.status).toBe(410);
  });

  it('a tool-dispatch failure surfaces as 500 with the message (operator learns it did not run)', async () => {
    getApproval.mockResolvedValue(mcpApproval('appr-1'));
    approveApproval.mockRejectedValue(new Error('tool blew up'));
    const res = await handleMcpApproveRequest({
      method: 'POST',
      pathname: '/api/system/mcp/approve/appr-1',
      resolveSession: human,
      onError: () => undefined,
    });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'tool blew up' });
  });

  it('an unsupported method on the confirm path is 405', async () => {
    getApproval.mockResolvedValue(mcpApproval('appr-1'));
    const res = await handleMcpApproveRequest({
      method: 'PUT',
      pathname: '/api/system/mcp/approve/appr-1',
      resolveSession: human,
    });
    expect(res.status).toBe(405);
  });
});
