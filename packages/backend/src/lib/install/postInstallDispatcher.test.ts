/**
 * postInstallDispatcher tests — focused on the #2144 loud-skip behaviour of
 * `ensureProxyHosts`: a subdomain-typed variable with no resolvable public
 * domain must log a clear WARNING naming the affected subdomain(s), not
 * return silently (the old behaviour left the operator with a service that
 * "installed fine" but served NPM's default page with no explanation).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StackVariable } from '@/lib/stackInstall/postInstall';

const appendLog = vi.fn<(id: string, line: string) => Promise<void>>(async () => {});
vi.mock('./jobStore', () => ({
  appendLog: (id: string, line: string) => appendLog(id, line),
}));
vi.mock('./socketBridge', () => ({
  emitJobLog: () => {},
}));
vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: () => 'test-token',
}));

import { ensureProxyHosts } from './postInstallDispatcher';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

const subdomainVar = (
  varName: string,
  sub: string,
  exposure: 'public' | 'internal' | 'lan' = 'public',
): StackVariable => ({
  name: varName,
  value: sub,
  meta: { type: 'subdomain', proxyPort: '8080', exposure } as StackVariable['meta'],
});

beforeEach(() => {
  appendLog.mockClear();
  fetchSpy.mockReset();
});

describe('ensureProxyHosts — #2144 loud skip', () => {
  it('logs a clear warning naming the subdomain when no public domain resolves', async () => {
    await ensureProxyHosts('job1', [subdomainVar('IMMICH_SUBDOMAIN', 'photos')], undefined);
    // No POST — nothing to route without a domain.
    expect(fetchSpy).not.toHaveBeenCalled();
    // But it must NOT be silent: a warning names the skipped subdomain.
    const lines = appendLog.mock.calls.map(c => c[1]);
    const warn = lines.find(l => l.includes('photos'));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/skipped|public domain/i);
  });

  it('stays silent (no warning) when there are no subdomain vars at all', async () => {
    await ensureProxyHosts('job1', [{ name: 'PUBLIC_DOMAIN', value: '' }], undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
    // A truly empty/LAN install with no subdomain vars is a valid no-op —
    // no noisy warning.
    expect(appendLog).not.toHaveBeenCalled();
  });

  it('POSTs the proxy host when a public domain is present (no warning)', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true, created: ['photos.dopp.cloud'] }), { status: 200 }),
    );
    await ensureProxyHosts(
      'job1',
      [{ name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' }, subdomainVar('IMMICH_SUBDOMAIN', 'photos')],
      undefined,
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const skipWarn = appendLog.mock.calls.map(c => c[1]).find(l => /skipped/i.test(l));
    expect(skipWarn).toBeUndefined();
  });
});
