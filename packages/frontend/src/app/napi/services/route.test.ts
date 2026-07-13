/**
 * GET /napi/services — token-gated service list + health (#2252).
 * Deny #1, allow read #2/#4, and the lean {name,activeState,subState,health}
 * projection with health derived from the active/status signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  listServices: vi.fn(),
  verifyToken: vi.fn(),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: mocks.listServices },
}));
vi.mock('@/lib/auth/apiTokens', () => ({ verifyToken: mocks.verifyToken }));

import { GET } from './route';

function req(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:5888/napi/services', { method: 'GET', headers });
}

describe('GET /napi/services — token-gated projection', () => {
  beforeEach(() => {
    mocks.listServices.mockReset();
    mocks.verifyToken.mockReset();
  });

  it('NO token → 401, never lists (acceptance #1)', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(mocks.listServices).not.toHaveBeenCalled();
  });

  it('read Bearer → 200 + lean projection with derived health (#2, #4)', async () => {
    mocks.verifyToken.mockResolvedValue({ name: 'device', scopes: ['read'] });
    mocks.listServices.mockResolvedValue([
      { name: 'up', active: true, status: 'active' },
      { name: 'bad', active: false, status: 'failed' },
      { name: 'off', active: false, status: 'inactive' },
    ]);
    const res = await GET(req({ authorization: 'Bearer sb_read' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.services).toEqual([
      { name: 'up', activeState: 'active', subState: 'active', health: 'healthy' },
      { name: 'bad', activeState: 'inactive', subState: 'failed', health: 'failed' },
      { name: 'off', activeState: 'inactive', subState: 'inactive', health: 'stopped' },
    ]);
  });
});
