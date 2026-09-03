import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Locating NPM (`findNpmAdminUrl`) moved to `lib/npm/client.ts` with #2730;
// its cases live in `lib/npm/client.test.ts`.
import {
  bindCertToProxyHost,
  classifyCertBinding,
  deleteCertificate,
  indexProxyHostBindings,
  isCertOrphaned,
  listCertificates,
  renewCertificate,
  requestLetsEncryptCert,
  CERT_REQUEST_TIMEOUT_MS,
} from './certs';

describe('cert → proxy-host binding (#2594)', () => {
  const hosts = [
    { id: 1, certificate_id: 7, domain_names: ['vault.example.com'] },
    { id: 2, certificate_id: 0, domain_names: ['plain.example.com'] },
  ];
  const bindings = indexProxyHostBindings(hosts);

  it('indexes both the selected cert ids and the served domains', () => {
    expect([...bindings.certIds]).toEqual([7]); // certificate_id 0 = "no cert"
    expect([...bindings.domains].sort()).toEqual(['plain.example.com', 'vault.example.com']);
  });

  it('survives a non-array / malformed body without throwing', () => {
    expect(indexProxyHostBindings(undefined).certIds.size).toBe(0);
    expect(indexProxyHostBindings([{ domain_names: 'nope' }]).domains.size).toBe(0);
  });

  it('is orphaned only when neither the id nor any domain is referenced', () => {
    expect(isCertOrphaned({ id: 7, domain_names: ['vault.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: ['vault.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 7, domain_names: ['gone.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: ['gone.example.com'] }, bindings)).toBe(true);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(isCertOrphaned({ id: 99, domain_names: ['  VAULT.example.com '] }, bindings)).toBe(false);
  });

  it('treats a wildcard cert as in use while any host under it is served', () => {
    expect(isCertOrphaned({ id: 99, domain_names: ['*.example.com'] }, bindings)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: ['*.other.com'] }, bindings)).toBe(true);
  });

  it('never reports orphaned when the host table is unknown, or the cert has no domains', () => {
    expect(isCertOrphaned({ id: 99, domain_names: ['gone.example.com'] }, null)).toBe(false);
    expect(isCertOrphaned({ id: 99, domain_names: [] }, bindings)).toBe(false);
  });
});

// ─── The typed certificate client against an NPM stub (#2731) ───────────

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
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe('certificate client (#2731)', () => {
  beforeEach(() => { calls.length = 0; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('listCertificates passes expand=owner through and returns the rows', async () => {
    stub(() => json([{ id: 1, provider: 'letsencrypt' }]));
    const r = await listCertificates(NPM, TOKEN, { expand: ['owner'] });
    expect(r).toEqual({ ok: true, status: 200, data: [{ id: 1, provider: 'letsencrypt' }] });
    expect(calls[0].url).toBe(`${NPM}/api/nginx/certificates?expand=owner`);
    await listCertificates(NPM, TOKEN);
    expect(calls[1].url).toBe(`${NPM}/api/nginx/certificates`);
  });

  it('requestLetsEncryptCert sends the tightened NPM schema (no legacy email/agree fields)', async () => {
    stub(() => json({ id: 42 }, 201));
    const r = await requestLetsEncryptCert(NPM, TOKEN, 'a.example');
    expect(r).toEqual({ ok: true, status: 201, data: { id: 42 } });
    expect(calls[0].url).toBe(`${NPM}/api/nginx/certificates`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      provider: 'letsencrypt',
      domain_names: ['a.example'],
      meta: { dns_challenge: false },
    });
    expect(CERT_REQUEST_TIMEOUT_MS).toBe(120_000);
  });

  it('renewCertificate / deleteCertificate address the row by id', async () => {
    stub(() => json(true));
    await renewCertificate(NPM, TOKEN, '7');
    await deleteCertificate(NPM, TOKEN, 7);
    expect(calls.map(c => [c.url, c.init.method])).toEqual([
      [`${NPM}/api/nginx/certificates/7/renew`, 'POST'],
      [`${NPM}/api/nginx/certificates/7`, 'DELETE'],
    ]);
  });

  it('bindCertToProxyHost PUTs only the SSL fields', async () => {
    stub(() => json({}));
    const r = await bindCertToProxyHost(NPM, TOKEN, 9, 42);
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe(`${NPM}/api/nginx/proxy-hosts/9`);
    expect(calls[0].init.method).toBe('PUT');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      certificate_id: 42, ssl_forced: true, http2_support: true, hsts_enabled: false,
    });
  });

  it('classifyCertBinding resolves live against NPM and answers unknown when it cannot read', async () => {
    stub((url) => (url.includes('/certificates/')
      ? json({ id: 7, domain_names: ['gone.example.com'] })
      : json([{ id: 1, certificate_id: 3, domain_names: ['vault.example.com'] }])));
    expect(await classifyCertBinding(NPM, TOKEN, '7')).toEqual({ kind: 'orphaned', domains: ['gone.example.com'] });

    stub((url) => (url.includes('/certificates/')
      ? json({ id: 7, domain_names: ['vault.example.com'] })
      : json([{ id: 1, certificate_id: 3, domain_names: ['vault.example.com'] }])));
    expect(await classifyCertBinding(NPM, TOKEN, '7')).toEqual({ kind: 'in-use', domains: ['vault.example.com'] });

    stub(() => new Response('', { status: 404 }));
    expect(await classifyCertBinding(NPM, TOKEN, '7')).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('no certificate 7') });

    stub((url) => (url.includes('/certificates/') ? json({ id: 7, domain_names: ['x'] }) : new Response('', { status: 500 })));
    expect(await classifyCertBinding(NPM, TOKEN, '7')).toMatchObject({ kind: 'unknown', reason: expect.stringContaining('proxy-host list') });
  });
});
