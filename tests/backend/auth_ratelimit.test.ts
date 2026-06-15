// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkRateLimit,
  recordFailure,
  clearAttempts,
  clientKeyFromHeaders,
  _resetForTests,
} from '@/lib/auth/rateLimit';

beforeEach(() => _resetForTests());

describe('rate limiter', () => {
  it('allows attempts under the threshold', () => {
    const key = '1.2.3.4';
    for (let i = 0; i < 4; i++) {
      const d = checkRateLimit(key);
      expect(d.allowed).toBe(true);
      recordFailure(key);
    }
    expect(checkRateLimit(key).allowed).toBe(true);
  });

  it('blocks the 6th attempt and reports retry-after', () => {
    const key = '1.2.3.4';
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 5; i++) recordFailure(key, t0);
    const d = checkRateLimit(key, t0);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSec).toBeGreaterThan(0);
    expect(d.retryAfterSec).toBeLessThanOrEqual(15 * 60);
  });

  it('expires old failures outside the window', () => {
    const key = '1.2.3.4';
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 5; i++) recordFailure(key, t0);
    const later = t0 + 16 * 60 * 1000; // 16 min later
    expect(checkRateLimit(key, later).allowed).toBe(true);
  });

  it('clearAttempts wipes the bucket on success', () => {
    const key = '1.2.3.4';
    for (let i = 0; i < 5; i++) recordFailure(key);
    expect(checkRateLimit(key).allowed).toBe(false);
    clearAttempts(key);
    expect(checkRateLimit(key).allowed).toBe(true);
  });

  it('keys are independent', () => {
    for (let i = 0; i < 5; i++) recordFailure('1.1.1.1');
    expect(checkRateLimit('1.1.1.1').allowed).toBe(false);
    expect(checkRateLimit('2.2.2.2').allowed).toBe(true);
  });
});

describe('clientKeyFromHeaders', () => {
  it('uses the LAST (nginx-appended, trusted) hop of x-forwarded-for, not the first', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' });
    expect(clientKeyFromHeaders(h)).toBe('10.0.0.1');
  });

  it('prefers x-real-ip (set authoritatively by NPM) over x-forwarded-for', () => {
    const h = new Headers({ 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.1, 10.0.0.1' });
    expect(clientKeyFromHeaders(h)).toBe('198.51.100.7');
  });

  it('falls back to x-real-ip when no XFF is present', () => {
    const h = new Headers({ 'x-real-ip': '198.51.100.7' });
    expect(clientKeyFromHeaders(h)).toBe('198.51.100.7');
  });

  it('a spoofed left-most XFF does not rotate the rate-limit bucket key', () => {
    // An attacker behind the proxy rotates the client-controllable first hop
    // per request to dodge the brute-force limit; the trusted last hop (the
    // one nginx appends) is constant, so every request collapses to one key.
    const trustedHop = '10.0.0.1';
    const k1 = clientKeyFromHeaders(new Headers({ 'x-forwarded-for': `1.1.1.1, ${trustedHop}` }));
    const k2 = clientKeyFromHeaders(new Headers({ 'x-forwarded-for': `2.2.2.2, ${trustedHop}` }));
    const k3 = clientKeyFromHeaders(new Headers({ 'x-forwarded-for': `evil, ${trustedHop}` }));
    expect(k1).toBe(trustedHop);
    expect(new Set([k1, k2, k3]).size).toBe(1);
  });

  it('returns "unknown" when no client header is present', () => {
    expect(clientKeyFromHeaders(new Headers())).toBe('unknown');
  });

  it('accepts Node-style header records', () => {
    expect(clientKeyFromHeaders({ 'x-forwarded-for': '203.0.113.5' })).toBe('203.0.113.5');
  });
});
