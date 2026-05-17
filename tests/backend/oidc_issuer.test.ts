/**
 * Unit tests for the OIDC issuer SSRF guard (#577).
 */

import { describe, it, expect } from 'vitest';
import { assertValidOidcIssuer } from '../../src/lib/auth/oidcIssuer';

describe('assertValidOidcIssuer', () => {
  it('accepts a normal https hostname', () => {
    expect(() => assertValidOidcIssuer('https://auth.dopp.cloud')).not.toThrow();
  });

  it('accepts an RFC1918 https address (homelab Authelia)', () => {
    // Intentional: many homelab setups run Authelia on a LAN IP. The
    // guard's job is to block loopback / link-local, not all internal
    // addresses.
    expect(() => assertValidOidcIssuer('https://10.0.0.5:9091')).not.toThrow();
    expect(() => assertValidOidcIssuer('https://192.168.1.10')).not.toThrow();
  });

  it('rejects http:// (must be TLS)', () => {
    expect(() => assertValidOidcIssuer('http://auth.dopp.cloud')).toThrow(/https/);
  });

  it.each([
    'file:///etc/passwd',
    'gopher://attacker',
    'javascript:alert(1)',
  ])('rejects non-http(s) scheme: %s', (url) => {
    expect(() => assertValidOidcIssuer(url)).toThrow();
  });

  it('rejects userinfo in the URL', () => {
    expect(() => assertValidOidcIssuer('https://attacker:pass@evil.com')).toThrow(/userinfo/);
  });

  it.each([
    'https://localhost',
    'https://LocalHost:1234',
    'https://foo.localhost',
    'https://127.0.0.1',
    'https://127.255.255.254',
    'https://0.0.0.0',
  ])('rejects loopback: %s', (url) => {
    expect(() => assertValidOidcIssuer(url)).toThrow();
  });

  it.each([
    'https://169.254.169.254',
    'https://[fe80::1]',
    'https://[::1]',
  ])('rejects link-local / IPv6 loopback: %s', (url) => {
    expect(() => assertValidOidcIssuer(url)).toThrow();
  });

  it('rejects garbage URLs', () => {
    expect(() => assertValidOidcIssuer('not a url')).toThrow();
    expect(() => assertValidOidcIssuer('')).toThrow();
  });
});
