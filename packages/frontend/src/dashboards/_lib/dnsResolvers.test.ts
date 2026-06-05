import { describe, it, expect } from 'vitest';
import { labelResolver, summarizeDnsResolvers } from './dnsResolvers';

describe('labelResolver', () => {
  it('labels loopback as AdGuard (the box runs AdGuard)', () => {
    expect(labelResolver('127.0.0.1')).toEqual({ address: '127.0.0.1', label: 'AdGuard', isPublic: false });
    expect(labelResolver('::1').label).toBe('AdGuard');
  });

  it("labels the box's own non-internal IP as AdGuard", () => {
    expect(labelResolver('192.168.178.100', ['192.168.178.100'])).toMatchObject({ label: 'AdGuard', isPublic: false });
  });

  it('labels RFC1918 LAN addresses as router', () => {
    expect(labelResolver('192.168.178.1')).toMatchObject({ label: 'router', isPublic: false });
    expect(labelResolver('10.0.0.1')).toMatchObject({ label: 'router', isPublic: false });
    expect(labelResolver('172.16.5.4')).toMatchObject({ label: 'router', isPublic: false });
  });

  it('labels well-known public resolvers as public (the #1559 trap)', () => {
    for (const ip of ['8.8.8.8', '8.8.4.4', '1.1.1.1', '9.9.9.9', '149.112.112.112']) {
      expect(labelResolver(ip)).toMatchObject({ label: 'public', isPublic: true });
    }
  });

  it('treats an unknown non-private address as public/upstream', () => {
    expect(labelResolver('203.0.113.7')).toMatchObject({ label: 'public', isPublic: true });
  });

  it('labels IPv6 unique-local / link-local as router', () => {
    expect(labelResolver('fd00::1')).toMatchObject({ label: 'router', isPublic: false });
    expect(labelResolver('fe80::1')).toMatchObject({ label: 'router', isPublic: false });
  });

  it('labels IPv6 public resolvers as public', () => {
    expect(labelResolver('2001:4860:4860::8888')).toMatchObject({ label: 'public', isPublic: true });
  });
});

describe('summarizeDnsResolvers', () => {
  it('flags hasPublicResolver when a public resolver is present (the #1559 trap)', () => {
    const summary = summarizeDnsResolvers({ servers: ['192.168.178.1', '8.8.8.8'], source: 'resolvectl' });
    expect(summary.hasPublicResolver).toBe(true);
    expect(summary.resolvers.map(r => r.label)).toEqual(['router', 'public']);
    expect(summary.source).toBe('resolvectl');
  });

  it('does not flag when all resolvers are local (AdGuard / router)', () => {
    const summary = summarizeDnsResolvers(
      { servers: ['127.0.0.1', '192.168.178.1'], source: 'resolv.conf' },
      [],
    );
    expect(summary.hasPublicResolver).toBe(false);
    expect(summary.resolvers.map(r => r.label)).toEqual(['AdGuard', 'router']);
  });

  it('tolerates a missing / empty report', () => {
    expect(summarizeDnsResolvers(null)).toEqual({ resolvers: [], hasPublicResolver: false, source: 'unknown' });
    expect(summarizeDnsResolvers({ servers: [] }).resolvers).toHaveLength(0);
  });
});
