import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkNginxOnline,
  createProxyHost,
  deleteProxyHost,
  findProxyHostByDomain,
  getProxyHost,
  listProxyHosts,
  setProxyHostEnabled,
  updateProxyHost,
} from './proxyHosts';
import { npmRequest, toResult, toStatus, NPM_DEFAULT_TIMEOUT_MS } from './http';

/**
 * #2731 — the typed NPM client against an in-memory NPM stub. Each case
 * pins the exact URL / method / headers / body a call sends, because the
 * route- and probe-level tests key their `fetch` stubs on those shapes;
 * changing one here is changing the contract every caller relies on.
 */

const NPM = 'http://npm';
const TOKEN = 'tok';

type Recorded = { url: string; init: RequestInit };
const calls: Recorded[] = [];

function stub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }));
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => { calls.length = 0; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('npmRequest (transport)', () => {
  it('sets bearer + JSON headers only when it has something to send', async () => {
    stub(() => json({}));
    await npmRequest(NPM, '/api/x', { token: TOKEN, body: { a: 1 }, method: 'POST' });
    await npmRequest(NPM, '/api/y');
    const [withBody, bare] = calls;
    expect(withBody.url).toBe(`${NPM}/api/x`);
    expect(withBody.init.method).toBe('POST');
    expect(withBody.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' });
    expect(withBody.init.body).toBe('{"a":1}');
    expect(bare.init.method).toBe('GET');
    expect(bare.init.headers).toEqual({});
    expect(bare.init.body).toBeUndefined();
    expect(bare.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never throws on an HTTP error status; toResult/toStatus carry the body', async () => {
    stub(() => new Response('boom', { status: 500 }));
    const r = await toResult(await npmRequest(NPM, '/api/x'));
    expect(r).toEqual({ ok: false, status: 500, body: 'boom' });
    stub(() => new Response('nope', { status: 404 }));
    expect(await toStatus(await npmRequest(NPM, '/api/x'))).toEqual({ ok: false, status: 404, body: 'nope' });
  });

  it('tolerates a bare `{ ok, status }` stub with no body reader', async () => {
    // Route tests stub fetch with `{ ok: true, status: 200 } as Response`.
    stub(() => ({ ok: true, status: 200 }) as Response);
    expect(await toStatus(await npmRequest(NPM, '/api/x'))).toEqual({ ok: true, status: 200, body: '' });
    stub(() => ({ ok: false, status: 502 }) as Response);
    expect(await toStatus(await npmRequest(NPM, '/api/x'))).toEqual({ ok: false, status: 502, body: '' });
  });

  it('lets a transport failure propagate as the rejection it is', async () => {
    stub(() => { throw new Error('ECONNREFUSED'); });
    await expect(npmRequest(NPM, '/api/x')).rejects.toThrow('ECONNREFUSED');
  });

  it('defaults the abort budget to 10 s', () => {
    expect(NPM_DEFAULT_TIMEOUT_MS).toBe(10_000);
  });
});

describe('proxy hosts', () => {
  it('listProxyHosts passes the expand list through verbatim (or no query at all)', async () => {
    stub(() => json([{ id: 1, domain_names: ['a.example'] }]));
    const r = await listProxyHosts(NPM, TOKEN, { expand: ['owner', 'access_list', 'certificate'] });
    expect(r).toEqual({ ok: true, status: 200, data: [{ id: 1, domain_names: ['a.example'] }] });
    expect(calls[0].url).toBe(`${NPM}/api/nginx/proxy-hosts?expand=owner,access_list,certificate`);
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    await listProxyHosts(NPM, TOKEN);
    expect(calls[1].url).toBe(`${NPM}/api/nginx/proxy-hosts`);
  });

  it('getProxyHost reads one row by id', async () => {
    stub(() => json({ id: 7, meta: { nginx_online: true } }));
    const r = await getProxyHost(NPM, TOKEN, 7);
    expect(r.ok && r.data.id).toBe(7);
    expect(calls[0].url).toBe(`${NPM}/api/nginx/proxy-hosts/7`);
  });

  it('findProxyHostByDomain returns the matching row, null when absent, null when unreadable', async () => {
    stub(() => json([{ id: 1, domain_names: ['a.example'] }, { id: 2, domain_names: ['b.example', 'c.example'] }]));
    expect((await findProxyHostByDomain(NPM, TOKEN, 'c.example'))?.id).toBe(2);
    expect(await findProxyHostByDomain(NPM, TOKEN, 'zzz.example')).toBeNull();
    stub(() => new Response('', { status: 500 }));
    expect(await findProxyHostByDomain(NPM, TOKEN, 'a.example')).toBeNull();
    stub(() => { throw new Error('timeout'); });
    expect(await findProxyHostByDomain(NPM, TOKEN, 'a.example')).toBeNull();
  });

  it('createProxyHost POSTs the body and returns the created row', async () => {
    stub(() => json({ id: 9 }, 201));
    const body = {
      domain_names: ['a.example'], forward_host: '10.0.0.2', forward_port: 8080, forward_scheme: 'http',
      enabled: true, allow_websocket_upgrade: false, block_exploits: true, caching_enabled: false,
      http2_support: true, ssl_forced: true, hsts_enabled: false, hsts_subdomains: false,
      access_list_id: 0, certificate_id: 0, meta: { letsencrypt_agree: false, dns_challenge: false },
      advanced_config: '', locations: [],
    };
    const r = await createProxyHost(NPM, TOKEN, body);
    expect(r).toEqual({ ok: true, status: 201, data: { id: 9 } });
    expect(calls[0].url).toBe(`${NPM}/api/nginx/proxy-hosts`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual(body);
  });

  it('createProxyHost surfaces a 400 with its body instead of throwing', async () => {
    stub(() => json({ error: { message: 'domain_names already in use' } }, 400));
    const r = await createProxyHost(NPM, TOKEN, { domain_names: ['a.example'] } as never);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(400);
    expect(!r.ok && r.body).toContain('already in use');
  });

  it('updateProxyHost PUTs exactly the patch it is given', async () => {
    stub(() => json({}));
    const r = await updateProxyHost(NPM, TOKEN, 7, { forward_host: '10.0.0.3', forward_port: 81 });
    expect(r).toEqual({ ok: true, status: 200, body: '' });
    expect(calls[0].url).toBe(`${NPM}/api/nginx/proxy-hosts/7`);
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ forward_host: '10.0.0.3', forward_port: 81 });
  });

  it('deleteProxyHost DELETEs by id', async () => {
    stub(() => json(true));
    const r = await deleteProxyHost(NPM, TOKEN, 7);
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe(`${NPM}/api/nginx/proxy-hosts/7`);
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].init.body).toBeUndefined();
  });

  it('setProxyHostEnabled POSTs to /disable and /enable', async () => {
    stub(() => json(true));
    await setProxyHostEnabled(NPM, TOKEN, 7, false);
    await setProxyHostEnabled(NPM, TOKEN, 7, true);
    expect(calls.map(c => c.url)).toEqual([`${NPM}/api/nginx/proxy-hosts/7/disable`, `${NPM}/api/nginx/proxy-hosts/7/enable`]);
    expect(calls.every(c => c.init.method === 'POST')).toBe(true);
  });

  it('checkNginxOnline reports a reverted conf and fails open otherwise', async () => {
    stub(() => json({ id: 7, meta: { nginx_online: false, nginx_err: '[emerg] duplicate location' } }));
    expect(await checkNginxOnline(NPM, TOKEN, 7)).toEqual({ online: false, err: '[emerg] duplicate location' });
    stub(() => json({ id: 7, meta: { nginx_online: true } }));
    expect(await checkNginxOnline(NPM, TOKEN, 7)).toEqual({ online: true });
    stub(() => new Response('', { status: 500 }));
    expect(await checkNginxOnline(NPM, TOKEN, 7)).toEqual({ online: true });
    stub(() => { throw new Error('timeout'); });
    expect(await checkNginxOnline(NPM, TOKEN, 7)).toEqual({ online: true });
  });
});
