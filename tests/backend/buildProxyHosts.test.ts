import { describe, it, expect } from 'vitest';
import { buildProxyHosts, type StackVariable } from '@/lib/stackInstall/postInstall';

/**
 * Regression coverage for the public-vs-LAN routing rule in
 * `buildProxyHosts`. Prior to the fix, every subdomain — including those
 * a template flagged `exposure: 'lan'` — landed on `<sub>.<publicDomain>`,
 * which surfaced two visible symptoms in `public` mode installs:
 *   1. The DNS-verify probe complained about a missing A record for
 *      `zwave.<publicDomain>` even though Z-Wave is LAN-only by design.
 *   2. If the operator created that A record anyway, the Z-Wave UI was
 *      reachable from the public internet without a Let's Encrypt cert.
 * The function now honours `exposure` and routes LAN hosts to
 * `<sub>.home.arpa` (or `LAN_DOMAIN` when set).
 */

const v = (
  name: string,
  value: string,
  meta?: StackVariable['meta'],
): StackVariable => ({ name, value, meta });

const subdomain = (
  exposure: 'public' | 'lan' | undefined,
  port: string,
  extras: Partial<NonNullable<StackVariable['meta']>> = {},
): StackVariable['meta'] => ({
  type: 'subdomain',
  proxyPort: port,
  ...(exposure ? { exposure } : {}),
  ...extras,
});

describe('buildProxyHosts', () => {
  it('routes public-exposure subdomains onto PUBLIC_DOMAIN with a public flag', () => {
    const { domain, hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('HA_SUBDOMAIN', 'home', subdomain('public', '8123')),
    ]);
    expect(domain).toBe('example.com');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      domain: 'home.example.com',
      forwardPort: 8123,
      exposure: 'public',
      service: 'ha',
    });
  });

  it('routes lan-exposure subdomains onto the LAN domain (default home.arpa)', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('ZWAVE_JS_SUBDOMAIN', 'zwave', subdomain('lan', '8091')),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      domain: 'zwave.home.arpa',
      forwardPort: 8091,
      exposure: 'lan',
      service: 'zwave_js',
    });
  });

  it('honours LAN_DOMAIN override when present', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('LAN_DOMAIN', 'lan.example'),
      v('ZWAVE_JS_SUBDOMAIN', 'zwave', subdomain('lan', '8091')),
    ]);
    expect(hosts[0].domain).toBe('zwave.lan.example');
  });

  it('treats missing exposure as lan (conservative — never auto-cert)', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('MYSTERY_SUBDOMAIN', 'mystery', subdomain(undefined, '9000')),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      domain: 'mystery.home.arpa',
      exposure: 'lan',
    });
  });

  it('routes mixed exposures from a single install correctly', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'dopp.cloud'),
      v('HA_SUBDOMAIN', 'home', subdomain('public', '8123')),
      v('ZWAVE_JS_SUBDOMAIN', 'zwave', subdomain('lan', '8091')),
      v('IMMICH_SUBDOMAIN', 'photos', subdomain('public', '2283')),
    ]);
    const byDomain = Object.fromEntries(hosts.map(h => [h.domain, h]));
    expect(byDomain['home.dopp.cloud'].exposure).toBe('public');
    expect(byDomain['photos.dopp.cloud'].exposure).toBe('public');
    expect(byDomain['zwave.home.arpa'].exposure).toBe('lan');
    expect(hosts).toHaveLength(3);
  });

  it('skips public-exposure hosts when PUBLIC_DOMAIN is empty (LAN-only install)', () => {
    const { domain, hosts } = buildProxyHosts([
      v('HA_SUBDOMAIN', 'home', subdomain('public', '8123')),
      v('ZWAVE_JS_SUBDOMAIN', 'zwave', subdomain('lan', '8091')),
    ]);
    expect(domain).toBeUndefined();
    expect(hosts.map(h => h.domain)).toEqual(['zwave.home.arpa']);
  });

  it('resolves proxyPort given as a variable reference', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('AUTHELIA_PORT', '9091'),
      v('AUTH_SUBDOMAIN', 'auth', subdomain('public', 'AUTHELIA_PORT')),
    ]);
    expect(hosts[0].forwardPort).toBe(9091);
  });

  it('drops subdomain entries with an unresolvable port', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('BROKEN_SUBDOMAIN', 'broken', subdomain('public', 'NOT_A_PORT_VAR')),
      v('OK_SUBDOMAIN', 'ok', subdomain('public', '8080')),
    ]);
    expect(hosts.map(h => h.domain)).toEqual(['ok.example.com']);
  });

  it('skips subdomain variables whose value is empty', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('UNSET_SUBDOMAIN', '', subdomain('public', '8000')),
      v('SET_SUBDOMAIN', 'real', subdomain('public', '8001')),
    ]);
    expect(hosts.map(h => h.domain)).toEqual(['real.example.com']);
  });

  it('uses templateName from meta when present, else derives from var name', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('ABS_SUBDOMAIN', 'audio', subdomain('public', '13378', { templateName: 'media' })),
      v('NAVIDROME_SUBDOMAIN', 'navi', subdomain('public', '4533', { templateName: 'media' })),
      v('FOO_SUBDOMAIN', 'foo', subdomain('public', '5000')),
    ]);
    expect(hosts.find(h => h.domain === 'audio.example.com')?.service).toBe('media');
    expect(hosts.find(h => h.domain === 'navi.example.com')?.service).toBe('media');
    expect(hosts.find(h => h.domain === 'foo.example.com')?.service).toBe('foo');
  });
});
