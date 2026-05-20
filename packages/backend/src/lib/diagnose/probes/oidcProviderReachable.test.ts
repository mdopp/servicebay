import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(),
}));

// Mock the agent manager so the log-fetch path inside the probe doesn't
// open a real connection during unit tests. Tests can override the
// per-call behavior by stubbing `agentManager.ensureAgent`.
const sendCommandMock = vi.fn();
vi.mock('@/lib/agent/manager', () => ({
  agentManager: {
    ensureAgent: vi.fn(async () => ({ sendCommand: sendCommandMock })),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getConfig } from '@/lib/config';
import { checkOidcProviderReachable, classifyAutheliaLogs } from './oidcProviderReachable';

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
  sendCommandMock.mockReset();
  // Default: log fetch returns nothing — tests that exercise the
  // classifier path override this.
  sendCommandMock.mockResolvedValue({ code: 0, stdout: '' });
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
    // New structured behaviour: the hint references the structured
    // action label, not the loose "podman logs" paragraph.
    expect(r.hint).toMatch(/Show recent logs|Reset wizard|Restart auth/i);
    expect(r.category).toBeDefined();
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
    expect(r.hint).toBeDefined();
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

  // #736 — classification surfaces a specific cause in `detail` so the
  // diagnose card can show "storage drift" / "LDAP bind" / "config
  // invalid" instead of a paragraph listing all three.
  it('classifies 500 + storage-key log tail as category=storage', async () => {
    vi.mocked(getConfig).mockResolvedValue(baseConfig as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    sendCommandMock.mockResolvedValueOnce({
      code: 0,
      stdout: 'level=fatal msg="unable to decrypt the storage encryption key has been altered"',
    });
    const r = await checkOidcProviderReachable();
    expect(r.status).toBe('fail');
    expect(r.category).toBe('storage');
    expect(r.detail).toMatch(/encryption key drift/i);
  });

  it('classifies 500 + LDAP-bind log tail as category=ldap', async () => {
    vi.mocked(getConfig).mockResolvedValue(baseConfig as never);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    sendCommandMock.mockResolvedValueOnce({
      code: 0,
      stdout: 'level=error msg="error occurred performing LDAP bind: LDAP Result Code 49 \\"Invalid Credentials\\""',
    });
    const r = await checkOidcProviderReachable();
    expect(r.status).toBe('fail');
    expect(r.category).toBe('ldap');
    expect(r.detail).toMatch(/LDAP bind/i);
  });
});

describe('classifyAutheliaLogs', () => {
  it('returns unknown for empty logs', () => {
    expect(classifyAutheliaLogs('').category).toBe('unknown');
  });

  it('matches config errors before LDAP', () => {
    const logs = 'Configuration: parse error at line 14: expected mapping value\nLDAP Result Code 49 "Invalid Credentials"';
    expect(classifyAutheliaLogs(logs).category).toBe('config');
  });

  it('matches storage drift', () => {
    const logs = 'fatal error: unable to decrypt the storage encryption key';
    expect(classifyAutheliaLogs(logs).category).toBe('storage');
  });
});
