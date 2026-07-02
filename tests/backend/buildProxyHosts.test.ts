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
  exposure: 'public' | 'internal' | 'lan' | undefined,
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

  it('routes lan-exposure subdomains onto the public domain when one is configured', () => {
    // Architectural shift: LAN-only services share the public domain
    // (e.g. `zwave.example.com`). The AdGuard wildcard
    // `*.<publicDomain> → <lanIp>` keeps LAN clients on the local IP
    // without any external DNS dependency, and the absence of a public
    // A-record for the LAN-only subset stops external resolution dead.
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('ZWAVE_JS_SUBDOMAIN', 'zwave', subdomain('lan', '8091')),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      domain: 'zwave.example.com',
      forwardPort: 8091,
      exposure: 'lan',
      service: 'zwave_js',
    });
  });

  it('falls back to home.arpa when no public domain is configured', () => {
    // LAN-only install: there's nothing to graft onto. Keep the old
    // `<sub>.home.arpa` behaviour so RFC 8375 + AdGuard rewrites
    // still give the operator a working LAN-only setup.
    const { hosts } = buildProxyHosts([
      v('ZWAVE_JS_SUBDOMAIN', 'zwave', subdomain('lan', '8091')),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      domain: 'zwave.home.arpa',
      exposure: 'lan',
    });
  });

  it('treats missing exposure as lan (conservative — never auto-cert)', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('MYSTERY_SUBDOMAIN', 'mystery', subdomain(undefined, '9000')),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      domain: 'mystery.example.com',
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
    // Same domain for public and lan now — the AdGuard wildcard +
    // absence of a public A-record for the LAN-only one provides
    // the split-horizon implicitly.
    expect(byDomain['zwave.dopp.cloud'].exposure).toBe('lan');
    expect(hosts).toHaveLength(3);
  });

  it('skips public-exposure hosts when PUBLIC_DOMAIN is empty (LAN-only install)', () => {
    const { domain, hosts } = buildProxyHosts([
      v('HA_SUBDOMAIN', 'home', subdomain('public', '8123')),
      v('ZWAVE_JS_SUBDOMAIN', 'zwave', subdomain('lan', '8091')),
    ]);
    expect(domain).toBeUndefined();
    // No public domain → fallback `home.arpa` covers the LAN entry.
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

  it('routes internal-exposure subdomains onto PUBLIC_DOMAIN with internal flag', () => {
    // `internal` is `public` for routing (needs a real DNS A-record so LE
    // HTTP-01 can validate) but the install runner binds the LAN-only
    // access list. ACME-challenge bypasses that list inside NPM by design.
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('ZWAVE_JS_SUBDOMAIN', 'zwave', subdomain('internal', '8091')),
    ]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      domain: 'zwave.example.com',
      forwardPort: 8091,
      exposure: 'internal',
    });
  });

  it('skips internal-exposure hosts when PUBLIC_DOMAIN is empty (no domain to graft onto)', () => {
    // Internal requires a real cert which requires a real domain.
    // Without PUBLIC_DOMAIN the host is dropped — `home.arpa` can't
    // hold a public LE cert, so falling back would create a broken
    // (cert-less) host. Surface this loudly via the dropped entry
    // and let the wizard's PUBLIC_DOMAIN validation catch it.
    const { hosts } = buildProxyHosts([
      v('ZWAVE_JS_SUBDOMAIN', 'zwave', subdomain('internal', '8091')),
    ]);
    expect(hosts).toEqual([]);
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

  it('never renders an empty Authelia port in a forward-auth proxyConfig (#1677)', () => {
    // A gated service installed WITHOUT the `auth` template in the same
    // batch (so the variables carry no AUTHELIA_PORT) must still get a
    // concrete port — an empty `127.0.0.1:` is an nginx [emerg] that
    // crashes the whole proxy on reload. The default (9091) is seeded.
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('OLLAMA_SUBDOMAIN', 'ollama', subdomain('public', '11434', {
        proxyConfig: { advanced_config: '__authelia_forward_auth__' },
      })),
    ]);
    const cfg = hosts[0].proxyConfig?.advanced_config ?? '';
    expect(cfg).toContain('proxy_pass http://127.0.0.1:9091/api/authz/auth-request;');
    expect(cfg).not.toContain('127.0.0.1:/api/authz');
    // The placeholder is fully substituted (no literal mustache left).
    expect(cfg).not.toContain('{{AUTHELIA_PORT}}');
  });

  it('uses the install batch AUTHELIA_PORT when present (#1677)', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('AUTHELIA_PORT', '9095'),
      v('OLLAMA_SUBDOMAIN', 'ollama', subdomain('public', '11434', {
        proxyConfig: { advanced_config: '__authelia_forward_auth__' },
      })),
    ]);
    const cfg = hosts[0].proxyConfig?.advanced_config ?? '';
    expect(cfg).toContain('proxy_pass http://127.0.0.1:9095/api/authz/auth-request;');
  });

  // #2143 — the forward-auth snippet's acme-challenge bypass duplicates NPM's
  // own on LE (public/internal) hosts → `nginx: [emerg] duplicate location`.
  it('omits the acme-challenge bypass for public/internal (LE) forward-auth hosts (#2143)', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('AUTHELIA_PORT', '9091'),
      v('PUB_SUBDOMAIN', 'pub', subdomain('public', '8000', {
        proxyConfig: { advanced_config: '__authelia_forward_auth__' },
      })),
      v('INT_SUBDOMAIN', 'int', subdomain('internal', '8001', {
        proxyConfig: { advanced_config: '__authelia_forward_auth__' },
      })),
    ]);
    for (const h of hosts) {
      const cfg = h.proxyConfig?.advanced_config ?? '';
      expect(cfg).not.toContain('acme-challenge');
      // still gated
      expect(cfg).toContain('auth_request /authelia;');
    }
  });

  it('keeps the acme-challenge bypass for cert-less lan forward-auth hosts (#2143)', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('AUTHELIA_PORT', '9091'),
      v('LAN_SUBDOMAIN', 'lan', subdomain('lan', '8000', {
        proxyConfig: { advanced_config: '__authelia_forward_auth__' },
      })),
    ]);
    const cfg = hosts[0].proxyConfig?.advanced_config ?? '';
    expect(cfg).toContain('location /.well-known/acme-challenge/');
    expect(cfg).toContain('auth_request /authelia;');
  });

  it('routes loopback-only services through 127.0.0.1 (#880)', () => {
    const { hosts } = buildProxyHosts([
      v('PUBLIC_DOMAIN', 'example.com'),
      v('SYNC_SUBDOMAIN', 'sync', subdomain('internal', '8384', { loopbackOnly: true })),
      v('PHOTOS_SUBDOMAIN', 'photos', subdomain('internal', '2283')),
    ]);
    const sync = hosts.find(h => h.domain === 'sync.example.com');
    const photos = hosts.find(h => h.domain === 'photos.example.com');
    // NPM runs hostNetwork=true, so its 127.0.0.1 IS the host's
    // loopback where Syncthing's GUI listens.
    expect(sync?.forwardHost).toBe('127.0.0.1');
    // Regular services don't override — the proxy-hosts route defaults
    // forwardHost to the node's LAN IP.
    expect(photos?.forwardHost).toBeUndefined();
  });
});
