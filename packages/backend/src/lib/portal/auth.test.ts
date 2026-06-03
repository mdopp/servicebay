import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn() } }));

import { getConfig } from '@/lib/config';
import { verifyAutheliaSession } from './auth';

const mockedGetConfig = vi.mocked(getConfig);

function autheliaResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe('verifyAutheliaSession', () => {
  beforeEach(() => {
    mockedGetConfig.mockResolvedValue({
      reverseProxy: { publicDomain: 'dopp.cloud' },
    } as unknown as Awaited<ReturnType<typeof getConfig>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns anonymous without a cookie (no Authelia call)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(verifyAutheliaSession(null)).resolves.toEqual({ user: null, name: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probes the www.<domain> subdomain, NOT the bare apex (#1606)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(autheliaResponse(200, { 'remote-user': 'alice', 'remote-name': 'Alice Doe' }));

    await verifyAutheliaSession('authelia_session=abc');

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const original = (init.headers as Record<string, string>)['X-Original-URL'];
    expect(original).toBe('https://www.dopp.cloud/');
    expect(original).not.toContain('/portal');
  });

  it('calls the 4.38+ /api/authz/auth-request endpoint with X-Original-Method, not deprecated /api/verify', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(autheliaResponse(200, { 'remote-user': 'alice', 'remote-name': 'Alice Doe' }));

    await verifyAutheliaSession('authelia_session=abc');

    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toContain('/api/authz/auth-request');
    expect(url).not.toContain('/api/verify');
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-Original-Method']).toBe('GET');
  });

  it('maps a 200 + identity headers to the signed-in visitor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      autheliaResponse(200, { 'remote-user': 'alice', 'remote-name': 'Alice Doe' }),
    );
    await expect(verifyAutheliaSession('authelia_session=abc')).resolves.toEqual({
      user: 'alice',
      name: 'Alice Doe',
    });
  });

  it('falls back to anonymous on a non-ok response (e.g. 401/403)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(autheliaResponse(403));
    await expect(verifyAutheliaSession('authelia_session=abc')).resolves.toEqual({ user: null, name: null });
  });

  it('falls back to anonymous when Authelia is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(verifyAutheliaSession('authelia_session=abc')).resolves.toEqual({ user: null, name: null });
  });
});
