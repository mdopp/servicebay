import { describe, it, expect } from 'vitest';
import {
  assertValidHost,
  assertValidPort,
  assertWritablePassword,
} from '../../packages/backend/src/lib/sshValidate';

describe('assertValidHost', () => {
  it('accepts a plain hostname unchanged', () => {
    expect(assertValidHost('box.local')).toBe('box.local');
    expect(assertValidHost('servicebay')).toBe('servicebay');
    expect(assertValidHost('a-b.example.com')).toBe('a-b.example.com');
  });

  it('accepts IPv4 and IPv6 literals', () => {
    expect(assertValidHost('192.168.178.100')).toBe('192.168.178.100');
    expect(assertValidHost('::1')).toBe('::1');
    expect(assertValidHost('fe80::1')).toBe('fe80::1');
  });

  it('trims surrounding whitespace', () => {
    expect(assertValidHost('  box.local  ')).toBe('box.local');
  });

  it('rejects a URL / scheme (SSRF shape)', () => {
    expect(() => assertValidHost('http://evil.example/')).toThrow(/Invalid host/);
    expect(() => assertValidHost('http://169.254.169.254/latest/meta-data')).toThrow(/Invalid host/);
  });

  it('rejects userinfo, path, port, and metacharacters', () => {
    expect(() => assertValidHost('user@evil.example')).toThrow(/Invalid host/);
    expect(() => assertValidHost('evil.example:22')).toThrow(/Invalid host/);
    expect(() => assertValidHost('evil.example/path')).toThrow(/Invalid host/);
    expect(() => assertValidHost('h; rm -rf /')).toThrow(/Invalid host/);
    expect(() => assertValidHost('h$(id)')).toThrow(/Invalid host/);
    expect(() => assertValidHost('box .local')).toThrow(/Invalid host/);
  });

  it('rejects empty and over-long hosts', () => {
    expect(() => assertValidHost('')).toThrow(/Invalid host/);
    expect(() => assertValidHost('   ')).toThrow(/Invalid host/);
    expect(() => assertValidHost('a'.repeat(254))).toThrow(/Invalid host/);
  });

  it('rejects labels with leading/trailing hyphens', () => {
    expect(() => assertValidHost('-bad.example')).toThrow(/Invalid host/);
    expect(() => assertValidHost('bad-.example')).toThrow(/Invalid host/);
  });

  it('returns a value built only from the allowlist alphabet (SSRF barrier)', () => {
    // The returned host must be content-identical to the (trimmed) input for a
    // legit host — the char-by-char rebuild keeps every allowed character — and
    // must contain no character outside the hostname/IP alphabet. This pins the
    // js/request-forgery barrier: the connection target is derived from an
    // allowlist, not passed through as the raw tainted string.
    for (const h of ['box.local', 'a-b.example.com', '192.168.178.100', 'fe80::1', '::1']) {
      const out = assertValidHost(h);
      expect(out).toBe(h);
      expect(out).toMatch(/^[A-Za-z0-9.:-]+$/);
    }
  });
});

describe('assertValidPort', () => {
  it('accepts a valid port unchanged', () => {
    expect(assertValidPort(22)).toBe(22);
    expect(assertValidPort(1)).toBe(1);
    expect(assertValidPort(65535)).toBe(65535);
  });

  it('rejects out-of-range and non-integer ports', () => {
    expect(() => assertValidPort(0)).toThrow(/Invalid port/);
    expect(() => assertValidPort(65536)).toThrow(/Invalid port/);
    expect(() => assertValidPort(-1)).toThrow(/Invalid port/);
    expect(() => assertValidPort(22.5)).toThrow(/Invalid port/);
    expect(() => assertValidPort(Number.NaN)).toThrow(/Invalid port/);
  });
});

describe('assertWritablePassword', () => {
  it('accepts a normal password with symbols unchanged', () => {
    expect(assertWritablePassword('hunter2!@#$%^&*()')).toBe('hunter2!@#$%^&*()');
    expect(assertWritablePassword('with spaces ok')).toBe('with spaces ok');
  });

  it('rejects a password containing a newline (extra-PTY-line injection)', () => {
    expect(() => assertWritablePassword('pass\nrm -rf /')).toThrow(/control characters/);
    expect(() => assertWritablePassword('pass\r\nmore')).toThrow(/control characters/);
  });

  it('rejects other control characters', () => {
    expect(() => assertWritablePassword('pass\ttab')).toThrow(/control characters/);
    expect(() => assertWritablePassword('pass\x00nul')).toThrow(/control characters/);
    expect(() => assertWritablePassword('pass\x7fdel')).toThrow(/control characters/);
  });
});
