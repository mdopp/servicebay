/**
 * POST /napi/approvals/:id/deny — companion-app verdict delivery (#2253).
 *
 * Same self-approve guard as the approve twin: a `mutate`-scope Bearer may
 * deliver a "deny" verdict, but the token that PROPOSED the request cannot
 * resolve it. Gate/scope machinery lives in requireSession.test.ts; the exact
 * `mutate` scope in OPTIONS is pinned in ../../../scopeGuards.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ApprovalRequest } from '@/lib/approvals';

const mocks = vi.hoisted(() => ({
  rejectApproval: vi.fn(),
  getApproval: vi.fn(),
  verifyDelegatedAdmin: vi.fn(),
  authRef: { value: undefined as { user: string } | undefined },
}));

vi.mock('@/lib/auth/delegatedAdmin', () => ({
  DELEGATION_HEADER: 'x-sb-delegated-admin',
  verifyDelegatedAdmin: mocks.verifyDelegatedAdmin,
}));

vi.mock('@/lib/approvals', async () => {
  const actual = await vi.importActual<typeof import('@/lib/approvals')>('@/lib/approvals');
  return {
    isSelfApproval: actual.isSelfApproval,
    rejectApproval: mocks.rejectApproval,
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
  service: 'honcho',
  title: 'delete_service: honcho',
  description: null,
  payload: { caller },
  on_approve: { mcp: { toolName: 'delete_service', args: { name: 'honcho' } } },
  on_reject: {},
  node: 'box1',
  created_at: new Date().toISOString(),
  status: 'pending',
});

const call = async (auth: { user: string } | undefined, delegationHeader?: string) => {
  mocks.authRef.value = auth;
  const headers = delegationHeader ? { 'x-sb-delegated-admin': delegationHeader } : undefined;
  const req = new NextRequest('http://localhost/napi/approvals/r1/deny', { method: 'POST', headers });
  return POST(req, { params: Promise.resolve({ id: 'r1' }) });
};

beforeEach(() => {
  mocks.rejectApproval.mockReset();
  mocks.getApproval.mockReset();
  mocks.verifyDelegatedAdmin.mockReset();
  mocks.rejectApproval.mockResolvedValue({ request: proposal('token:solaris') });
});

describe('POST /napi/approvals/:id/deny — self-approval guard (#2253, #2244)', () => {
  it('403s the token that proposed the request; the reject is NOT run', async () => {
    mocks.getApproval.mockResolvedValue(proposal('token:solaris'));
    const res = await call({ user: 'token:solaris' });
    expect(res.status).toBe(403);
    expect(mocks.rejectApproval).not.toHaveBeenCalled();
  });

  it('lets a DIFFERENT mutate token deliver the deny verdict (acceptance #2)', async () => {
    mocks.getApproval.mockResolvedValue(proposal('token:solaris'));
    const res = await call({ user: 'token:other' });
    expect(res.status).toBe(200);
    expect(mocks.rejectApproval).toHaveBeenCalledWith('r1');
  });

  it('lets the cookie operator deny (never a token proposer)', async () => {
    mocks.getApproval.mockResolvedValue(proposal('token:solaris'));
    const res = await call({ user: 'admin' });
    expect(res.status).toBe(200);
    expect(mocks.rejectApproval).toHaveBeenCalledWith('r1');
  });
});

describe('POST /napi/approvals/:id/deny — delegated-admin auth mode (#2268, ADR 0010)', () => {
  it('denies when a valid delegated-admin assertion is presented (runs AS the admin)', async () => {
    mocks.verifyDelegatedAdmin.mockResolvedValue({ ok: true, user: 'alice', assertion: {} });
    const res = await call({ user: 'token:solaris' }, 'valid-assertion');
    expect(res.status).toBe(200);
    expect(mocks.verifyDelegatedAdmin).toHaveBeenCalledWith(
      expect.objectContaining({ expectedAction: 'approvals.deny', expectedTarget: 'r1', rawAssertion: 'valid-assertion' }),
    );
    expect(mocks.getApproval).not.toHaveBeenCalled();
    expect(mocks.rejectApproval).toHaveBeenCalledWith('r1');
  });

  it('403s an INVALID assertion — never silently falls back to the raw token', async () => {
    mocks.verifyDelegatedAdmin.mockResolvedValue({ ok: false, reason: 'bad_signature', message: 'Delegated-admin assertion signature is invalid.' });
    const res = await call({ user: 'token:solaris' }, 'forged');
    expect(res.status).toBe(403);
    expect(mocks.rejectApproval).not.toHaveBeenCalled();
  });

  it('falls back to the device-token path when NO assertion header is present', async () => {
    mocks.getApproval.mockResolvedValue(proposal('token:solaris'));
    const res = await call({ user: 'token:other' });
    expect(mocks.verifyDelegatedAdmin).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(mocks.rejectApproval).toHaveBeenCalledWith('r1');
  });
});
