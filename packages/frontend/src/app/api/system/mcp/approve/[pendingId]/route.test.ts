/**
 * POST /api/system/mcp/approve/{pendingId} (#1766) — the cookie-only confirm.
 *
 * The whole security property of the approval gate lives here: the route
 * carries NO `tokenScope`, so a `Bearer sb_…` token (the proposing agent) is
 * IGNORED by requireSession and 401s. Only a logged-in human (session cookie)
 * can approve. We drive the REAL withApiHandlerParams → requireSession path and
 * mock only the auth primitives + the pending-approvals store.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const store = vi.hoisted(() => ({
  approve: vi.fn(),
}));

vi.mock('@/lib/mcp/pendingApprovals', () => {
  class ApprovalExpiredError extends Error {
    constructor(public readonly pendingId: string) {
      super(`Approval ${pendingId} has expired or does not exist`);
      this.name = 'ApprovalExpiredError';
    }
  }
  return {
    approvePendingApproval: store.approve,
    ApprovalExpiredError,
  };
});

// requireSession's three credential sources.
const auth = vi.hoisted(() => ({
  internalToken: 'internal-secret',
  session: null as null | { user: string; expires: Date },
  token: null as null | { name: string; scopes: string[] },
}));

vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: () => auth.internalToken,
}));
vi.mock('@/lib/auth/session', () => ({
  getSessionFromCookieHeader: vi.fn(async () => auth.session),
}));
vi.mock('@/lib/auth/apiTokens', () => ({
  verifyToken: vi.fn(async () => auth.token),
}));

import { POST } from './route';
import { ApprovalExpiredError } from '@/lib/mcp/pendingApprovals';

function reqWith(headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/system/mcp/approve/abc', {
    method: 'POST',
    headers,
  });
}
const ctx = { params: Promise.resolve({ pendingId: 'abc' }) };

describe('POST /api/system/mcp/approve/{pendingId} (#1766)', () => {
  beforeEach(() => {
    store.approve.mockReset();
    auth.session = null;
    auth.token = null;
  });

  it('REJECTS a Bearer-token caller with 401 — the agent cannot self-approve', async () => {
    // A valid token with destroy scope is presented…
    auth.token = { name: 'ci-bot', scopes: ['read', 'destroy'] };
    const res = await POST(reqWith({ authorization: 'Bearer sb_token' }), ctx);
    expect(res.status).toBe(401);
    // …and the stored call is NEVER executed.
    expect(store.approve).not.toHaveBeenCalled();
  });

  it('a cookie session (a logged-in human) approves and runs the call', async () => {
    auth.session = { user: 'admin', expires: new Date(Date.now() + 60_000) };
    store.approve.mockResolvedValue({ content: [{ type: 'text', text: 'deleted' }] });
    const res = await POST(reqWith({ cookie: 'sb_session=valid' }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(store.approve).toHaveBeenCalledWith('abc');
  });

  it('an unauthenticated caller (no cookie, no token) 401s', async () => {
    const res = await POST(reqWith({}), ctx);
    expect(res.status).toBe(401);
    expect(store.approve).not.toHaveBeenCalled();
  });

  it('an expired / unknown pending id returns 410 Gone for a cookie session', async () => {
    auth.session = { user: 'admin', expires: new Date(Date.now() + 60_000) };
    store.approve.mockRejectedValue(new ApprovalExpiredError('abc'));
    const res = await POST(reqWith({ cookie: 'sb_session=valid' }), ctx);
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/expired|already used/i);
  });
});
