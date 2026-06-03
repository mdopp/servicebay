import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getConfig } from '@/lib/config';
import { verifyAutheliaSession } from './auth';

/** Build a minimal Response-like with given status + identity headers. */
function autheliaResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

const PUBLIC_CONFIG = {
  reverseProxy: { publicDomain: 'dopp.cloud' },
  templateSettings: { AUTHELIA_PORT: '9091' },
};

const mockGetConfig = vi.mocked(getConfig);
const mockFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  mockGetConfig.mockResolvedValue(PUBLIC_CONFIG as unknown as Awaited<ReturnType<typeof getConfig>>);
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  mockFetch.mockReset();
});

describe('verifyAutheliaSession (#417 identity detection)', () => {
  it('returns anonymous immediately when there is no cookie (no Authelia call)', async () => {
    const result = await verifyAutheliaSession(null);
    expect(result).toEqual({ user: null, name: null });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('points X-Original-URL at the www subdomain, not the deny-default apex', async () => {
    mockFetch.mockResolvedValue(
      autheliaResponse(200, { 'remote-user': 'max', 'remote-name': 'Max Mustermann' }),
    );

    await verifyAutheliaSession('authelia_session=abc');

    const [url, init] = mockFetch.mock.calls[0];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    // Hits the 4.38+ nginx forward-auth endpoint, not the deprecated /api/verify.
    expect(url).toBe('http://127.0.0.1:9091/api/authz/auth-request');
    // www.<domain> is covered by the *.<domain> one_factor wildcard rule;
    // the bare apex falls through to default-deny (403) and never carries
    // identity headers. https scheme is mandatory (Authelia rejects http).
    expect(headers['X-Original-URL']).toBe('https://www.dopp.cloud/');
    expect(headers['X-Original-Method']).toBe('GET');
    expect(headers.Cookie).toBe('authelia_session=abc');
  });

  it('returns the user + name on a 200 with identity headers', async () => {
    mockFetch.mockResolvedValue(
      autheliaResponse(200, { 'remote-user': 'max', 'remote-name': 'Max Mustermann' }),
    );
    expect(await verifyAutheliaSession('authelia_session=abc')).toEqual({
      user: 'max',
      name: 'Max Mustermann',
    });
  });

  it('falls back to anonymous on 401 (no/expired session)', async () => {
    mockFetch.mockResolvedValue(autheliaResponse(401));
    expect(await verifyAutheliaSession('authelia_session=stale')).toEqual({ user: null, name: null });
  });

  it('falls back to anonymous on 403 (access-control rule miss)', async () => {
    mockFetch.mockResolvedValue(autheliaResponse(403));
    expect(await verifyAutheliaSession('authelia_session=abc')).toEqual({ user: null, name: null });
  });

  it('falls back to anonymous when Authelia is unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await verifyAutheliaSession('authelia_session=abc')).toEqual({ user: null, name: null });
  });

  it('treats empty identity headers as anonymous (bypass rule, no user injected)', async () => {
    mockFetch.mockResolvedValue(autheliaResponse(200));
    expect(await verifyAutheliaSession('authelia_session=abc')).toEqual({ user: null, name: null });
  });
});
