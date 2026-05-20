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
  it('uses the first hop of x-forwarded-for', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' });
    expect(clientKeyFromHeaders(h)).toBe('203.0.113.1');
  });

  it('falls back to x-real-ip', () => {
    const h = new Headers({ 'x-real-ip': '198.51.100.7' });
    expect(clientKeyFromHeaders(h)).toBe('198.51.100.7');
  });

  it('returns "unknown" when no client header is present', () => {
    expect(clientKeyFromHeaders(new Headers())).toBe('unknown');
  });

  it('accepts Node-style header records', () => {
    expect(clientKeyFromHeaders({ 'x-forwarded-for': '203.0.113.5' })).toBe('203.0.113.5');
  });
});
