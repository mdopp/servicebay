/**
 * /api/system/nginx/proxy-hosts — the thin handler over the proxy-host
 * kernel (#2731). Everything that touches NPM lives in
 * `@/lib/reverseProxy/proxyHostProvisioning`; this file only maps request
 * shapes to kernel calls and kernel result kinds to the HTTP statuses/bodies
 * the wizard, the NPM capability handler (#630) and token-driven flows
 * (#2142) already key on. These cases pin that mapping so the contract can't
 * drift while the kernel is refactored underneath it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  provisionProxyHosts: vi.fn(),
  removeProxyHost: vi.fn(),
  listLiveProxyHosts: vi.fn(),
}));

vi.mock('@/lib/reverseProxy/proxyHostProvisioning', () => ({
  provisionProxyHosts: mocks.provisionProxyHosts,
  removeProxyHost: mocks.removeProxyHost,
  listLiveProxyHosts: mocks.listLiveProxyHosts,
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mirrors the real wrapper: parse the query with the route's own schema, hand
// the request through, pass a Response back untouched.
vi.mock('@/lib/api/handler', () => ({
  withApiHandler:
    (
      opts: { query?: z.ZodType<unknown> },
      handler: (ctx: { query: unknown; request: NextRequest }) => Promise<unknown>,
    ) =>
    async (request: NextRequest) => {
      const query = opts.query
        ? opts.query.parse(Object.fromEntries(new URL(request.url).searchParams))
        : undefined;
      const result = await handler({ query, request });
      if (result instanceof Response) return result;
      return NextResponse.json({ ok: true, data: result });
    },
}));

import { POST, DELETE, GET } from './route';

const BASE = 'http://localhost:5888/api/system/nginx/proxy-hosts';

function post(body: unknown) {
  return POST(new NextRequest(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
const del = (qs: string) => DELETE(new NextRequest(`${BASE}${qs}`, { method: 'DELETE' }));
const get = (qs = '') => GET(new NextRequest(`${BASE}${qs}`, { method: 'GET' }));

beforeEach(() => {
  mocks.provisionProxyHosts.mockReset();
  mocks.removeProxyHost.mockReset();
  mocks.listLiveProxyHosts.mockReset();
});

describe('POST', () => {
  it('400s an empty host list without touching the kernel', async () => {
    const res = await post({ hosts: [] });
    expect(res.status).toBe(400);
    expect(mocks.provisionProxyHosts).not.toHaveBeenCalled();
  });

  it('hands hosts/node/publicDomain/npmCredentials to the kernel and returns its summary minus `kind`', async () => {
    mocks.provisionProxyHosts.mockResolvedValue({
      kind: 'ok', node: 'box', npmUrl: 'http://npm', configured: [{ domain: 'a.example' }], failed: [], certs: { 'a.example': 'issued' },
    });
    const hosts = [{ domain: 'a.example', forwardPort: 8080 }];
    const creds = { email: 'admin@example.com', password: 'pw' };
    const res = await post({ hosts, node: 'box', publicDomain: 'example.com', npmCredentials: creds });
    expect(res.status).toBe(200);
    expect(mocks.provisionProxyHosts).toHaveBeenCalledWith({ hosts, node: 'box', publicDomain: 'example.com', npmCredentials: creds });
    expect(await res.json()).toEqual({
      node: 'box', npmUrl: 'http://npm', configured: [{ domain: 'a.example' }], failed: [], certs: { 'a.example': 'issued' },
    });
  });

  it('maps npm-not-found → 404 and auth-failed → 401 with adminUrl + needsCredentials', async () => {
    mocks.provisionProxyHosts.mockResolvedValueOnce({ kind: 'npm-not-found' });
    let res = await post({ hosts: [{ domain: 'a.example', forwardPort: 1 }] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Nginx Proxy Manager not found or not running' });

    mocks.provisionProxyHosts.mockResolvedValueOnce({ kind: 'auth-failed', adminUrl: 'http://npm:81' });
    res = await post({ hosts: [{ domain: 'a.example', forwardPort: 1 }] });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'Could not authenticate with NPM. Please provide your NPM admin credentials.',
      adminUrl: 'http://npm:81',
      needsCredentials: true,
    });
  });

  it('turns a kernel throw into a 500 envelope', async () => {
    mocks.provisionProxyHosts.mockRejectedValue(new Error('boom'));
    const res = await post({ hosts: [{ domain: 'a.example', forwardPort: 1 }] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to configure proxy hosts' });
  });
});

describe('DELETE', () => {
  it('requires ?domain and forwards node', async () => {
    let res = await del('');
    expect(res.status).toBe(400);
    expect(mocks.removeProxyHost).not.toHaveBeenCalled();

    mocks.removeProxyHost.mockResolvedValue({ kind: 'removed', domain: 'a.example', id: 7 });
    res = await del('?domain=a.example&node=box');
    expect(mocks.removeProxyHost).toHaveBeenCalledWith('a.example', 'box');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true, domain: 'a.example', id: 7 });
  });

  it('maps every failure kind to the status uninstall paths key on', async () => {
    const cases: [unknown, number, unknown][] = [
      [{ kind: 'npm-not-found' }, 404, { error: 'Nginx Proxy Manager not found or not running' }],
      [{ kind: 'auth-failed', adminUrl: 'http://npm:81' }, 401, expect.objectContaining({ needsCredentials: true, adminUrl: 'http://npm:81' })],
      [{ kind: 'not-found' }, 404, { removed: false, reason: 'not_found' }],
      [{ kind: 'npm-error', status: 503 }, 502, { error: 'NPM API returned 503' }],
    ];
    for (const [result, status, body] of cases) {
      mocks.removeProxyHost.mockResolvedValueOnce(result);
      const res = await del('?domain=a.example');
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
    }
  });
});

describe('GET', () => {
  it('returns the live host table for the node', async () => {
    mocks.listLiveProxyHosts.mockResolvedValue({ kind: 'ok', node: 'box', hosts: [{ id: 1, domain: 'a.example', enabled: true, nginxOnline: true }] });
    const res = await get('?node=box');
    expect(mocks.listLiveProxyHosts).toHaveBeenCalledWith('box');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ node: 'box', hosts: [{ id: 1, domain: 'a.example', enabled: true, nginxOnline: true }] });
  });

  it('maps npm-not-found / auth-failed / npm-error like the other verbs', async () => {
    mocks.listLiveProxyHosts.mockResolvedValueOnce({ kind: 'npm-not-found' });
    expect((await get()).status).toBe(404);
    mocks.listLiveProxyHosts.mockResolvedValueOnce({ kind: 'auth-failed', adminUrl: 'http://npm:81' });
    const unauth = await get();
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: 'Could not authenticate with NPM.', adminUrl: 'http://npm:81', needsCredentials: true });
    mocks.listLiveProxyHosts.mockResolvedValueOnce({ kind: 'npm-error', status: 500 });
    const bad = await get();
    expect(bad.status).toBe(502);
    expect(await bad.json()).toEqual({ error: 'NPM API returned 500' });
  });
});
