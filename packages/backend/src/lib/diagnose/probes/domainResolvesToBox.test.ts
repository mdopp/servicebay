import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfig = vi.fn();
const resolve4 = vi.fn();

vi.mock('@/lib/config', () => ({
  getConfig: () => getConfig(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The probe now resolves via the LAN path (AdGuard) rather than the OS
// resolver — mock that helper. The mock returns A-records by hostname so
// the per-call assertions below still pin which domains were looked up.
vi.mock('@/lib/router/lanResolver', () => ({
  resolve4ViaLan: (h: string) => resolve4(h),
}));

import { checkDomainResolvesToBox } from './domainResolvesToBox';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('domain_resolves_to_box', () => {
  it('info when no LAN IP is recorded', async () => {
    getConfig.mockResolvedValue({ reverseProxy: { publicDomain: 'dopp.cloud' } });
    const r = await checkDomainResolvesToBox();
    expect(r.status).toBe('info');
    expect(r.detail).toContain('No LAN IP');
  });

  it('info when no public domains are configured', async () => {
    getConfig.mockResolvedValue({ reverseProxy: { lanIp: '192.168.178.100' } });
    const r = await checkDomainResolvesToBox();
    expect(r.status).toBe('info');
    expect(resolve4).not.toHaveBeenCalled();
  });

  it('ok when every core domain resolves to the box IP', async () => {
    getConfig.mockResolvedValue({
      reverseProxy: {
        publicDomain: 'dopp.cloud',
        lanIp: '192.168.178.100',
        hosts: [{ domain: 'vault.dopp.cloud', exposure: 'public' }],
      },
    });
    resolve4.mockResolvedValue(['192.168.178.100']);
    const r = await checkDomainResolvesToBox();
    expect(r.status).toBe('ok');
    // ldap. + auth. + the one public host = 3 lookups.
    expect(resolve4).toHaveBeenCalledTimes(3);
    expect(resolve4).toHaveBeenCalledWith('ldap.dopp.cloud');
    expect(resolve4).toHaveBeenCalledWith('auth.dopp.cloud');
    expect(resolve4).toHaveBeenCalledWith('vault.dopp.cloud');
  });

  it('fail (blocking) when a core domain does not resolve at all', async () => {
    getConfig.mockResolvedValue({
      reverseProxy: { publicDomain: 'dopp.cloud', lanIp: '192.168.178.100', hosts: [] },
    });
    // resolve4ViaLan swallows resolver errors and returns null — mirror that.
    resolve4.mockResolvedValue(null);
    const r = await checkDomainResolvesToBox();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('does not resolve');
    expect(r.hint).toContain('Pattern A');
  });

  it('fail when a core domain resolves to the wrong IP (DNS points elsewhere)', async () => {
    getConfig.mockResolvedValue({
      reverseProxy: { publicDomain: 'dopp.cloud', lanIp: '192.168.178.100', hosts: [] },
    });
    resolve4.mockResolvedValue(['203.0.113.7']);
    const r = await checkDomainResolvesToBox();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('expected 192.168.178.100');
    expect(r.hint).toContain('DHCP DNS');
  });

  it('resolves via the LAN/AdGuard path (not the OS resolver) — passes the box lanIp through', async () => {
    const lanSpy = vi.fn().mockResolvedValue(['192.168.178.100']);
    const mod = await import('@/lib/router/lanResolver');
    const orig = mod.resolve4ViaLan;
    // Re-point the mocked helper to a spy that records the (host, lanIp) pair.
    (resolve4 as unknown as { mockImplementation: (f: (h: string) => unknown) => void }).mockImplementation(
      (h: string) => lanSpy(h, '192.168.178.100'),
    );
    getConfig.mockResolvedValue({
      reverseProxy: { publicDomain: 'dopp.cloud', lanIp: '192.168.178.100', hosts: [] },
    });
    const r = await checkDomainResolvesToBox();
    expect(r.status).toBe('ok');
    expect(lanSpy).toHaveBeenCalledWith('auth.dopp.cloud', '192.168.178.100');
    void orig;
  });

  it('skips LAN-only hosts (resolved via AdGuard rewrites, not the box resolver)', async () => {
    getConfig.mockResolvedValue({
      reverseProxy: {
        publicDomain: 'dopp.cloud',
        lanIp: '192.168.178.100',
        hosts: [
          { domain: 'photos.dopp.cloud', exposure: 'public' },
          { domain: 'nas.home.arpa', exposure: 'lan' },
        ],
      },
    });
    resolve4.mockResolvedValue(['192.168.178.100']);
    await checkDomainResolvesToBox();
    const looked = resolve4.mock.calls.map(c => c[0]);
    expect(looked).toContain('photos.dopp.cloud');
    expect(looked).not.toContain('nas.home.arpa');
  });
});
