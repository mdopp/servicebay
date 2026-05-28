// @vitest-environment node
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ||
    '0123456789abcdef0123456789abcdef0123456789abcdef';
});

// withApiHandler's per-route session gate (#596) — let it pass so the handler
// body runs; the body's own header/session logic is what we're testing.
vi.mock('@/lib/api/requireSession', () => ({
  requireSession: vi.fn(async () => ({ user: 'admin', expires: new Date(Date.now() + 86400_000) })),
}));

import { GET } from '../../packages/frontend/src/app/api/auth/me/route';

describe('GET /api/auth/me', () => {
  it('reads the user from forward-auth Remote-* headers when present', async () => {
    const req = new NextRequest('http://test/api/auth/me', {
      headers: { 'remote-user': 'alice', 'remote-name': 'Alice', 'remote-groups': 'admins, family' },
    });
    const data = await (await GET(req)).json();
    expect(data).toMatchObject({
      authenticated: true,
      username: 'alice',
      displayName: 'Alice',
      source: 'forward-auth',
    });
    expect(data.groups).toEqual(['admins', 'family']);
  });

  it('falls back to the ServiceBay session when no Remote-* headers (LAN-direct)', async () => {
    const { encryptSession } = await import('@/lib/auth/session');
    const token = await encryptSession({ user: 'sbadmin', expires: new Date(Date.now() + 3600_000) });
    const req = new NextRequest('http://test/api/auth/me', {
      headers: { cookie: `session=${token}` },
    });
    const data = await (await GET(req)).json();
    expect(data).toMatchObject({ authenticated: true, username: 'sbadmin', source: 'session' });
    expect(data.groups).toEqual([]);
  });

  it('reports not-authenticated with neither headers nor a session cookie', async () => {
    const req = new NextRequest('http://test/api/auth/me');
    const data = await (await GET(req)).json();
    expect(data).toEqual({ authenticated: false });
  });
});
