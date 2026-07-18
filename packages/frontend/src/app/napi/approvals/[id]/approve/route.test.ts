/**
 * POST /napi/approvals/:id/approve — companion-app verdict delivery (#2253).
 *
 * Mirrors the browser /api/approvals/[id]/approve self-approve guard test: the
 * route is reachable by a `mutate`-scope Bearer (pinned in
 * ../../../scopeGuards.test.ts), but the human-in-the-loop invariant must hold —
 * the SAME token that PROPOSED a destroy-tier action cannot approve it (memory
 * reference_mcp_destroy_tier_approval_flow). Gate/scope machinery is covered in
 * requireSession.test.ts; here we stub the wrapper to inject `auth` and prove
 * the self-approve branch + the pass-through effect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ApprovalRequest } from '@/lib/approvals';

const mocks = vi.hoisted(() => ({
  approveApproval: vi.fn(),
  getApproval: vi.fn(),
  verifyDelegatedAdmin: vi.fn(),
  authRef: { value: undefined as { user: string } | undefined },
}));

vi.mock('@/lib/mcp/server', () => ({}));

// Delegated-admin guard (#2268) — inject verify results so the route's
// layered-auth branch is exercised without minting real HMAC assertions.
vi.mock('@/lib/auth/delegatedAdmin', () => ({
  DELEGATION_HEADER: 'x-sb-delegated-admin',
  verifyDelegatedAdmin: mocks.verifyDelegatedAdmin,
}));

vi.mock('@/lib/approvals', async () => {
  const actual = await vi.importActual<typeof import('@/lib/approvals')>('@/lib/approvals');
  return {
    isSelfApproval: actual.isSelfApproval,
    approveApproval: mocks.approveApproval,
    getApproval: mocks.getApproval,
  };
});

vi.mock('@/lib/api/handler', () => ({
  withApiHandlerParams:
    (
      _opts: unknown,
      handler: (ctx: { request: NextRequest; params: { id: string }; auth?: { user: string } }) => Promise<Response>,
    ) =>
    async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) =>
      handler({ request, params: await ctx.params, auth: mocks.authRef.value }),
}));

import { POST } from './route';

const proposal = (caller: string): ApprovalRequest => ({
  id: 'r1',
  service: 'media',
  title: 'delete_service: media',
  description: null,
  payload: { caller },
  on_approve: { mcp: { toolName: 'delete_service', args: { name: 'media' } } },
  on_reject: {},
  node: 'box1',
  created_at: new Date().toISOString(),
  status: 'pending',
});

const call = async (auth: { user: string } | undefined, delegationHeader?: string) => {
  mocks.authRef.value = auth;
  const headers = delegationHeader ? { 'x-sb-delegated-admin': delegationHeader } : undefined;
  const req = new NextRequest('http://localhost/napi/approvals/r1/approve', { method: 'POST', headers });
  return POST(req, { params: Promise.resolve({ id: 'r1' }) });
};

beforeEach(() => {
  mocks.approveApproval.mockReset();
  mocks.getApproval.mockReset();
  mocks.verifyDelegatedAdmin.mockReset();
  mocks.approveApproval.mockResolvedValue({ request: proposal('token:solaris') });
});

describe('POST /napi/approvals/:id/approve — self-approval guard (#2253, #2244)', () => {
  it('403s the token that proposed the request; the tool is NOT run', async () => {
    mocks.getApproval.mockResolvedValue(proposal('token:solaris'));
    const res = await call({ user: 'token:solaris' });
    expect(res.status).toBe(403);
    expect(mocks.approveApproval).not.toHaveBeenCalled();
  });

  it('lets a DIFFERENT mutate token deliver the verdict (acceptance #2)', async () => {
    mocks.getApproval.mockResolvedValue(proposal('token:solaris'));
    const res = await call({ user: 'token:other' });
    expect(res.status).toBe(200);
    expect(mocks.approveApproval).toHaveBeenCalledWith('r1');
  });

  it('lets the cookie operator approve (never a token proposer)', async () => {
    mocks.getApproval.mockResolvedValue(proposal('token:solaris'));
    const res = await call({ user: 'admin' });
    expect(res.status).toBe(200);
    expect(mocks.approveApproval).toHaveBeenCalledWith('r1');
  });
});

describe('POST /napi/approvals/:id/approve — delegated-admin auth mode (#2268, ADR 0010)', () => {
  it('approves when a valid delegated-admin assertion is presented (runs AS the admin)', async () => {
    mocks.verifyDelegatedAdmin.mockResolvedValue({ ok: true, user: 'alice', assertion: {} });
    // Even the self-approve-blocked token proposer is allowed through: the
    // delegated path resolved a REAL admin, so the token-self-approve guard does
    // not apply (the guard is only for the raw-token fallback).
    const res = await call({ user: 'token:solaris' }, 'valid-assertion');
    expect(res.status).toBe(200);
    expect(mocks.verifyDelegatedAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAction: 'approvals.approve', expectedTarget: 'r1', rawAssertion: 'valid-assertion' }),
    );
    expect(mocks.getApproval).not.toHaveBeenCalled(); // no fallback self-approve lookup
    expect(mocks.approveApproval).toHaveBeenCalledWith('r1');
  });

  it('403s an INVALID assertion — never silently falls back to the raw token', async () => {
    mocks.verifyDelegatedAdmin.mockResolvedValue({ ok: false, reason: 'not_admin', message: 'Asserted user is not a ServiceBay admin.' });
    const res = await call({ user: 'token:solaris' }, 'forged-or-nonadmin');
    expect(res.status).toBe(403);
    expect(mocks.approveApproval).not.toHaveBeenCalled();
  });

  it('falls back to the device-token path when NO assertion header is present', async () => {
    mocks.getApproval.mockResolvedValue(proposal('token:solaris'));
    const res = await call({ user: 'token:other' });
    expect(mocks.verifyDelegatedAdmin).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(mocks.approveApproval).toHaveBeenCalledWith('r1');
  });
});
