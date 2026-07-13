/**
 * GET /napi/approvals — token-gated pending-approval feed (#2252).
 *
 * Reuses the SAME listApprovals store as /api/approvals; this test proves the
 * token gate (deny #1, allow read #2/#4) and that only PENDING items surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  listApprovals: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock('@/lib/approvals', () => ({ listApprovals: mocks.listApprovals }));
vi.mock('@/lib/auth/apiTokens', () => ({ verifyToken: mocks.verifyToken }));

import { GET } from './route';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:5888/napi/approvals', { method: 'GET', headers });
}

describe('GET /napi/approvals — token-gated, pending-only', () => {
  beforeEach(() => {
    mocks.listApprovals.mockReset();
    mocks.verifyToken.mockReset();
  });

  it('NO token → 401, never reads the store (acceptance #1)', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mocks.listApprovals).not.toHaveBeenCalled();
  });

  it('read Bearer → 200, returns ONLY pending approvals (#2, #4)', async () => {
    mocks.verifyToken.mockResolvedValue({ name: 'device', scopes: ['read'] });
    mocks.listApprovals.mockResolvedValue([
      { id: '1', service: 'x', title: 't1', status: 'pending' },
      { id: '2', service: 'y', title: 't2', status: 'approved' },
      { id: '3', service: 'z', title: 't3', status: 'pending' },
    ]);
    const res = await GET(req({ authorization: 'Bearer sb_read' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals.map((a: { id: string }) => a.id)).toEqual(['1', '3']);
  });
});
