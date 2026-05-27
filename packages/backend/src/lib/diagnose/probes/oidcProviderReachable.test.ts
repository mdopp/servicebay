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
import { checkOidcProviderReachable, classifyAutheliaLogs, trimToCurrentStartup } from './oidcProviderReachable';

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

  // #781 — Authelia derives its effective issuer from Host +
  // X-Forwarded-Proto. Without those, a healthy install answers
  // HTTP 500 to a plain `127.0.0.1` GET. The probe must look like
  // proxied traffic.
  it('sends X-Forwarded-Proto: https and Host: auth.<publicDomain>', async () => {
    vi.mocked(getConfig).mockResolvedValue(baseConfig as never);
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify(validDiscovery), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await checkOidcProviderReachable();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Forwarded-Proto']).toBe('https');
    expect(headers['Host']).toBe('auth.example.com');
    expect(headers['X-Forwarded-Host']).toBe('auth.example.com');
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

  // #781 — stale errors from a previous process must not outvote
  // the current process's actual state. A startup banner resets the
  // classification window.
  it('ignores LDAP errors that precede the most recent startup banner', () => {
    const logs = [
      'time="2026-05-20T10:00:00Z" level=error msg="LDAP Result Code 49 Invalid Credentials"',
      'time="2026-05-21T08:00:00Z" level=info msg="Authelia v4.39.19 is starting"',
      'time="2026-05-21T08:00:01Z" level=info msg="Listening on 0.0.0.0:9091"',
    ].join('\n');
    expect(classifyAutheliaLogs(logs).category).toBe('unknown');
  });

  it('still classifies errors that appear after the startup banner', () => {
    const logs = [
      'time="2026-05-21T08:00:00Z" level=info msg="Authelia v4.39.19 is starting"',
      'time="2026-05-21T08:00:01Z" level=error msg="LDAP Result Code 49 Invalid Credentials"',
    ].join('\n');
    expect(classifyAutheliaLogs(logs).category).toBe('ldap');
  });
});

describe('trimToCurrentStartup', () => {
  it('returns input unchanged when no banner is present', () => {
    const logs = 'level=error msg="something broke"\nlevel=warn msg="another thing"';
    expect(trimToCurrentStartup(logs)).toBe(logs);
  });

  it('trims everything before the banner when one is present', () => {
    const logs = [
      'level=error msg="old failure"',
      'level=info msg="Authelia v4.39.19 is starting"',
      'level=info msg="ready"',
    ].join('\n');
    const trimmed = trimToCurrentStartup(logs);
    expect(trimmed).not.toContain('old failure');
    expect(trimmed).toContain('is starting');
    expect(trimmed).toContain('ready');
  });

  it('uses the LAST banner when several are present (process restarts)', () => {
    const logs = [
      'level=info msg="Authelia v4.39.18 is starting"',
      'level=error msg="first-boot error"',
      'level=info msg="Authelia v4.39.19 is starting"',
      'level=info msg="post-restart line"',
    ].join('\n');
    const trimmed = trimToCurrentStartup(logs);
    expect(trimmed).not.toContain('first-boot error');
    expect(trimmed).toContain('post-restart line');
  });
});
