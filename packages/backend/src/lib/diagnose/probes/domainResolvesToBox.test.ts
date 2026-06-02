import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfig = vi.fn();
const resolve4 = vi.fn();

vi.mock('@/lib/config', () => ({
  getConfig: () => getConfig(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('dns/promises', () => ({
  default: { resolve4: (h: string) => resolve4(h) },
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
    resolve4.mockRejectedValue(new Error('ENOTFOUND'));
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
