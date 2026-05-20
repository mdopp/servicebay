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
});
