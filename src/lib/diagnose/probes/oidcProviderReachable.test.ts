import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(),
}));

import { getConfig } from '@/lib/config';
import { checkOidcProviderReachable } from './oidcProviderReachable';

const baseConfig = {
  reverseProxy: { publicDomain: 'example.com' },
  installedTemplates: { auth: { schemaVersion: 1, installedAt: '2026-05-18T00:00:00Z' } },
};

const validDiscovery = {
  issuer: 'https://auth.example.com',
  authorization_endpoint: 'https://auth.example.com/api/oidc/authorization',
  token_endpoint: 'https://auth.example.com/api/oidc/token',
  userinfo_endpoint: 'https://auth.example.com/api/oidc/userinfo',
  jwks_uri: 'https://auth.example.com/jwks.json',
};

beforeEach(() => {
  vi.mocked(getConfig).mockReset();
  vi.restoreAllMocks();
});

describe('oidc_provider_reachable probe', () => {
  it('skips with info when auth template is not installed', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      reverseProxy: { publicDomain: 'example.com' },
      installedTemplates: {},
    } as never);
    const r = await checkOidcProviderReachable();
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/not installed/i);
  });

  it('skips with info when publicDomain is not configured yet', async () => {
    vi.mocked(getConfig).mockResolvedValue({
      reverseProxy: {},
      installedTemplates: { auth: { schemaVersion: 1, installedAt: '' } },
    } as never);
    const r = await checkOidcProviderReachable();
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/publicDomain/i);
  });

  it('returns ok when discovery answers 200 with a valid document', async () => {
    vi.mocked(getConfig).mockResolvedValue(baseConfig as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(validDiscovery), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const r = await checkOidcProviderReachable();
    expect(r.status).toBe('ok');
  });

  // Regression for #622: probe must FAIL when Authelia returns 502 —
  // that's the exact symptom that was invisible to every existing probe.
  it('returns fail when discovery returns 502 (Authelia down behind NPM)', async () => {
    vi.mocked(getConfig).mockResolvedValue(baseConfig as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad Gateway', { status: 502 })));
    const r = await checkOidcProviderReachable();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('502');
    expect(r.hint).toMatch(/podman logs auth-authelia/i);
  });

  // Regression for #622: probe must FAIL when fetch itself throws
  // (Authelia container down, refusing connections). Hint guides the
  // operator to the most common reinstall-related cause.
  it('returns fail when the discovery endpoint refuses connections', async () => {
    vi.mocked(getConfig).mockResolvedValue(baseConfig as never);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const r = await checkOidcProviderReachable();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/did not respond/i);
    expect(r.detail).toContain('ECONNREFUSED');
    expect(r.hint).toMatch(/encryption key|crash-looping/i);
  });

  it('returns warn when 200 body is missing required endpoints', async () => {
    vi.mocked(getConfig).mockResolvedValue(baseConfig as never);
    const incomplete = { issuer: 'https://auth.example.com' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(incomplete), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
    const r = await checkOidcProviderReachable();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/missing/i);
    expect(r.detail).toMatch(/authorization_endpoint/);
  });

  it('returns fail when 200 body is not valid JSON (proxy mismatch)', async () => {
    vi.mocked(getConfig).mockResolvedValue(baseConfig as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>oops</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })));
    const r = await checkOidcProviderReachable();
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/not valid json/i);
  });
});
