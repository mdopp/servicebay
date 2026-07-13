/**
 * GET /napi/home — token-gated aggregated summary (#2252).
 *
 * Drives the REAL route through the REAL handler.ts gate (only the backend data
 * sources + token verification are mocked) to prove, end-to-end:
 *   - NO token / wrong-scope token → 401 (deny-by-default, acceptance #1)
 *   - a valid read-scoped Bearer → 200 (acceptance #2, cookie-free = #4)
 *   - the body aggregates services/approvals/updates counts in ONE call (#3)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  listServices: vi.fn(),
  listApprovals: vi.fn(),
  getInstalledImageUpdates: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: mocks.listServices },
}));
vi.mock('@/lib/approvals', () => ({ listApprovals: mocks.listApprovals }));
vi.mock('@/lib/imageDigest', () => ({ getInstalledImageUpdates: mocks.getInstalledImageUpdates }));
// The gate's Bearer path imports verifyToken lazily; mock it so a read token
// verifies without a real token store.
vi.mock('@/lib/auth/apiTokens', () => ({ verifyToken: mocks.verifyToken }));

import { GET } from './route';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:5888/napi/home', { method: 'GET', headers });
}

describe('GET /napi/home — token-gated aggregated summary', () => {
  beforeEach(() => {
    mocks.listServices.mockReset();
    mocks.listApprovals.mockReset();
    mocks.getInstalledImageUpdates.mockReset();
    mocks.verifyToken.mockReset();
  });

  it('NO token → 401, never touches the data sources (acceptance #1)', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mocks.listServices).not.toHaveBeenCalled();
    expect(mocks.listApprovals).not.toHaveBeenCalled();
    expect(mocks.getInstalledImageUpdates).not.toHaveBeenCalled();
  });

  it('wrong-scope token (mutate, no read) → 401 (acceptance #1)', async () => {
    mocks.verifyToken.mockResolvedValue({ name: 'dev', scopes: ['mutate'] });
    const res = await GET(req({ authorization: 'Bearer sb_mutate_only' }));
    expect(res.status).toBe(401);
    expect(mocks.listServices).not.toHaveBeenCalled();
  });

  it('read-scoped Bearer → 200 + aggregated counts in ONE call (#2, #3, #4)', async () => {
    mocks.verifyToken.mockResolvedValue({ name: 'device', scopes: ['read'] });
    mocks.listServices.mockResolvedValue([
      { name: 'a', active: true, status: 'active' },
      { name: 'b', active: true, status: 'active' },
      { name: 'c', active: false, status: 'failed' },
      { name: 'd', active: false, status: 'inactive' },
    ]);
    mocks.listApprovals.mockResolvedValue([
      { status: 'pending' },
      { status: 'pending' },
      { status: 'approved' },
    ]);
    mocks.getInstalledImageUpdates.mockResolvedValue([
      { service: 'a', updateAvailable: true },
      { service: 'b', updateAvailable: false },
      { service: 'c', updateAvailable: true },
    ]);

    const res = await GET(req({ authorization: 'Bearer sb_read_token' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      servicesUp: 2,
      servicesFailed: 1,
      servicesDown: 1,
      pendingApprovals: 2,
      pendingUpdates: 2,
    });
    // ONE call = one round-trip per source, no fan-out of duplicate polls.
    expect(mocks.listServices).toHaveBeenCalledOnce();
    expect(mocks.listApprovals).toHaveBeenCalledOnce();
    expect(mocks.getInstalledImageUpdates).toHaveBeenCalledOnce();
  });
});
