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
  authRef: { value: undefined as { user: string } | undefined },
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
      handler: (ctx: { params: { id: string }; auth?: { user: string } }) => Promise<Response>,
    ) =>
    async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) =>
      handler({ params: await ctx.params, auth: mocks.authRef.value }),
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

const call = async (auth: { user: string } | undefined) => {
  mocks.authRef.value = auth;
  const req = new NextRequest('http://localhost/napi/approvals/r1/deny', { method: 'POST' });
  return POST(req, { params: Promise.resolve({ id: 'r1' }) });
};

beforeEach(() => {
  mocks.rejectApproval.mockReset();
  mocks.getApproval.mockReset();
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
