/**
 * Unit tests for the FritzBox host SSRF guard (#578).
 */

import { describe, it, expect } from 'vitest';
import { assertValidFritzBoxHost } from '@/lib/fritzbox/client';

describe('assertValidFritzBoxHost', () => {
  it('accepts the default fritz.box mDNS hostname', () => {
    expect(() => assertValidFritzBoxHost('fritz.box')).not.toThrow();
  });

  it('accepts a typical LAN router IP (RFC1918)', () => {
    // The gateway is always on the LAN — RFC1918 must work.
    for (const ip of ['192.168.178.1', '192.168.1.1', '10.0.0.1', '172.16.0.1']) {
      expect(() => assertValidFritzBoxHost(ip), `ip=${ip}`).not.toThrow();
    }
  });

  it('accepts a custom router hostname', () => {
    expect(() => assertValidFritzBoxHost('router.lan')).not.toThrow();
  });

  it.each([
    'localhost',
    'LocalHost',
    'foo.localhost',
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
  ])('rejects loopback host: %s', (host) => {
    expect(() => assertValidFritzBoxHost(host)).toThrow();
  });

  it.each([
    '169.254.169.254',  // common cloud metadata service IP
    '[fe80::1]',
    '[::1]',
  ])('rejects link-local / IPv6 loopback: %s', (host) => {
    expect(() => assertValidFritzBoxHost(host)).toThrow();
  });

  it('rejects empty or non-string input', () => {
    expect(() => assertValidFritzBoxHost('')).toThrow();
    // @ts-expect-error — intentional bad input
    expect(() => assertValidFritzBoxHost(undefined)).toThrow();
    // @ts-expect-error — intentional bad input
    expect(() => assertValidFritzBoxHost(null)).toThrow();
  });

  // #1069: public-IP allowlist — was the gap behind the issue.
  // Loopback/link-local were already blocked; this adds the rest.

  it.each([
    '8.8.8.8',          // Google DNS
    '1.1.1.1',          // Cloudflare
    '203.0.113.42',     // TEST-NET-3
    '93.184.216.34',    // example.com
    '224.0.0.1',        // multicast
    '255.255.255.255',  // broadcast
  ])('rejects public / non-LAN IPv4: %s', (host) => {
    expect(() => assertValidFritzBoxHost(host)).toThrow(/private LAN address/);
  });

  it.each([
    '172.15.0.1',       // just below 172.16/12
    '172.32.0.1',       // just above 172.31
    '100.63.0.1',       // just below 100.64/10
    '100.128.0.1',      // just above 100.127
  ])('rejects IPv4 just outside the private ranges: %s', (host) => {
    expect(() => assertValidFritzBoxHost(host)).toThrow(/private LAN address/);
  });

  it.each([
    '100.64.0.1',       // CGNAT bottom
    '100.127.255.254',  // CGNAT top
    '172.16.0.1',       // RFC1918 boundary
    '172.31.255.254',   // RFC1918 boundary
  ])('accepts CGNAT and RFC1918 boundary IPv4: %s', (host) => {
    expect(() => assertValidFritzBoxHost(host)).not.toThrow();
  });

  it.each([
    '[2001:db8::1]',    // documentation prefix (public-ish)
    '[2606:4700:4700::1111]', // Cloudflare DNS v6
  ])('rejects public IPv6: %s', (host) => {
    expect(() => assertValidFritzBoxHost(host)).toThrow(/private IPv6 address/);
  });

  it.each([
    '[fc00::1]',        // ULA
    '[fd12:3456::1]',   // ULA random
  ])('accepts unique-local IPv6: %s', (host) => {
    expect(() => assertValidFritzBoxHost(host)).not.toThrow();
  });
});
