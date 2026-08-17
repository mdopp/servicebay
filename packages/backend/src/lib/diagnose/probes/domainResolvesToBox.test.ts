import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LanResolveResult } from '@/lib/router/lanResolver';

const getConfig = vi.fn();
const resolve4 = vi.fn();

vi.mock('@/lib/config', () => ({
  getConfig: () => getConfig(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The probe resolves via the LAN path (AdGuard) rather than the OS resolver
// — mock that helper. The mock returns an outcome by hostname so the
// per-call assertions below still pin which domains were looked up.
vi.mock('@/lib/router/lanResolver', () => ({
  resolve4ViaLanDetailed: (h: string, ip: string) => resolve4(h, ip),
}));

import { checkDomainResolvesToBox } from './domainResolvesToBox';

/** The old `string[] | null` shape, lifted to the outcome the resolver now
 *  reports, so the existing cases read the same. */
const ok = (...addresses: string[]): LanResolveResult => ({ outcome: 'ok', addresses });
const noAnswer = (): LanResolveResult => ({ outcome: 'no-answer', addresses: null, code: 'ENOTFOUND' });
const timeout = (): LanResolveResult => ({ outcome: 'timeout', addresses: null, code: 'ETIMEOUT' });

/** No real waiting in the retry path. */
const NO_WAIT = { retryDelayMs: 0 };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('domain_resolves_to_box', () => {
  it('info when no LAN IP is recorded', async () => {
    getConfig.mockResolvedValue({ reverseProxy: { publicDomain: 'dopp.cloud' } });
    const r = await checkDomainResolvesToBox(NO_WAIT);
    expect(r.status).toBe('info');
    expect(r.detail).toContain('No LAN IP');
  });

  it('info when no public domains are configured', async () => {
    getConfig.mockResolvedValue({ reverseProxy: { lanIp: '192.168.178.100' } });
    const r = await checkDomainResolvesToBox(NO_WAIT);
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
    resolve4.mockResolvedValue(ok('192.168.178.100'));
    const r = await checkDomainResolvesToBox(NO_WAIT);
    expect(r.status).toBe('ok');
    // ldap. + auth. + the one public host = 3 lookups.
    expect(resolve4).toHaveBeenCalledTimes(3);
    expect(resolve4).toHaveBeenCalledWith('ldap.dopp.cloud', '192.168.178.100');
    expect(resolve4).toHaveBeenCalledWith('auth.dopp.cloud', '192.168.178.100');
    expect(resolve4).toHaveBeenCalledWith('vault.dopp.cloud', '192.168.178.100');
  });

  it('fail (blocking) when a core domain answers NXDOMAIN', async () => {
    getConfig.mockResolvedValue({
      reverseProxy: { publicDomain: 'dopp.cloud', lanIp: '192.168.178.100', hosts: [] },
    });
    resolve4.mockResolvedValue(noAnswer());
    const r = await checkDomainResolvesToBox(NO_WAIT);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('no such name');
    expect(r.hint).toContain('Pattern A');
  });

  it('fail when a core domain resolves to the wrong IP (DNS points elsewhere)', async () => {
    getConfig.mockResolvedValue({
      reverseProxy: { publicDomain: 'dopp.cloud', lanIp: '192.168.178.100', hosts: [] },
    });
    resolve4.mockResolvedValue(ok('203.0.113.7'));
    const r = await checkDomainResolvesToBox(NO_WAIT);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('expected 192.168.178.100');
    expect(r.hint).toContain('DHCP DNS');
  });

  it('resolves via the LAN/AdGuard path (not the OS resolver) — passes the box lanIp through', async () => {
    getConfig.mockResolvedValue({
      reverseProxy: { publicDomain: 'dopp.cloud', lanIp: '192.168.178.100', hosts: [] },
    });
    resolve4.mockResolvedValue(ok('192.168.178.100'));
    const r = await checkDomainResolvesToBox(NO_WAIT);
    expect(r.status).toBe('ok');
    expect(resolve4).toHaveBeenCalledWith('auth.dopp.cloud', '192.168.178.100');
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
    resolve4.mockResolvedValue(ok('192.168.178.100'));
    await checkDomainResolvesToBox(NO_WAIT);
    const looked = resolve4.mock.calls.map(c => c[0]);
    expect(looked).toContain('photos.dopp.cloud');
    expect(looked).not.toContain('nas.home.arpa');
  });
});

/**
 * #2579 — the probe stood red for 37 runs naming domains that resolve fine.
 * Cause: the tail of its own 21-query burst was dropped by AdGuard's
 * per-client rate limit, timed out, and was reported as NXDOMAIN.
 */
describe('a query that got no answer is not a DNS misconfiguration (#2579)', () => {
  const config = {
    reverseProxy: {
      publicDomain: 'dopp.cloud',
      lanIp: '192.168.178.100',
      hosts: [
        { domain: 'paperless.dopp.cloud', exposure: 'internal' },
        { domain: 'daggerheart.dopp.cloud', exposure: 'public' },
      ],
    },
  };

  beforeEach(() => getConfig.mockResolvedValue(config));

  it('retries a timed-out lookup once, and reports ok when the retry answers', async () => {
    // Exactly the observed shape: the tail of the burst is dropped, and the
    // same names answer immediately when asked again.
    const dropped = new Set(['paperless.dopp.cloud', 'daggerheart.dopp.cloud']);
    resolve4.mockImplementation(async (host: string) => {
      if (dropped.delete(host)) return timeout();
      return ok('192.168.178.100');
    });

    const r = await checkDomainResolvesToBox(NO_WAIT);
    expect(r.status).toBe('ok');
    // 4 domains, 2 of them asked twice.
    expect(resolve4).toHaveBeenCalledTimes(6);
  });

  it('warns — never fails — when a lookup times out twice, and says so in the words of a timeout', async () => {
    resolve4.mockImplementation(async (host: string) =>
      host === 'paperless.dopp.cloud' ? timeout() : ok('192.168.178.100'),
    );

    const r = await checkDomainResolvesToBox(NO_WAIT);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('paperless.dopp.cloud');
    expect(r.detail).toContain('no answer');
    // The timeout hint must NOT send the operator off to reconfigure DHCP —
    // that is the fix for a different fault.
    expect(r.hint).not.toContain('Pattern A');
    expect(r.hint).toContain('rate limit');
    // And it must not claim the name doesn't exist.
    expect(r.detail).not.toContain('NXDOMAIN');
  });

  it('a resolver error is inconclusive too, not a failure', async () => {
    resolve4.mockImplementation(async (host: string) =>
      host === 'daggerheart.dopp.cloud'
        ? ({ outcome: 'error', addresses: null, code: 'ESERVFAIL' } satisfies LanResolveResult)
        : ok('192.168.178.100'),
    );
    const r = await checkDomainResolvesToBox(NO_WAIT);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('ESERVFAIL');
  });

  it('does not retry a definitive negative answer — the second ask would say the same', async () => {
    resolve4.mockResolvedValue(noAnswer());
    await checkDomainResolvesToBox(NO_WAIT);
    // 4 domains, each asked exactly once.
    expect(resolve4).toHaveBeenCalledTimes(4);
  });

  it('a real misconfiguration still fails, and unanswered domains ride along unjudged', async () => {
    resolve4.mockImplementation(async (host: string) => {
      if (host === 'paperless.dopp.cloud') return timeout();
      if (host === 'daggerheart.dopp.cloud') return noAnswer();
      return ok('192.168.178.100');
    });
    const r = await checkDomainResolvesToBox(NO_WAIT);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('daggerheart.dopp.cloud');
    expect(r.detail).toContain('not judged');
    expect(r.detail).toContain('paperless.dopp.cloud');
    expect(r.hint).toContain('Pattern A');
  });
});
