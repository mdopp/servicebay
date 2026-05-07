// In-memory sliding-window login rate limiter, keyed by client IP.
// Single-process custom server → no shared store needed. Resets on success.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

interface Bucket {
  failures: number[]; // unix-ms timestamps of recent failed attempts
}

const buckets = new Map<string, Bucket>();

function pruneOlderThan(b: Bucket, cutoff: number) {
  if (b.failures.length === 0) return;
  let i = 0;
  while (i < b.failures.length && b.failures[i] < cutoff) i++;
  if (i > 0) b.failures.splice(0, i);
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the next attempt is allowed (only set when blocked). */
  retryAfterSec?: number;
  /** Failures recorded in the current window — useful for logging. */
  recentFailures: number;
}

/**
 * Check whether a login attempt from `key` is currently allowed.
 * Does NOT mutate state — call recordFailure / clear after handling the attempt.
 */
export function checkRateLimit(
  key: string,
  now: number = Date.now(),
  windowMs: number = WINDOW_MS,
  maxFailures: number = MAX_FAILURES,
): RateLimitDecision {
  const b = buckets.get(key);
  if (!b) return { allowed: true, recentFailures: 0 };
  pruneOlderThan(b, now - windowMs);
  if (b.failures.length >= maxFailures) {
    const oldest = b.failures[0];
    const retryAfterMs = (oldest + windowMs) - now;
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      recentFailures: b.failures.length,
    };
  }
  return { allowed: true, recentFailures: b.failures.length };
}

export function recordFailure(key: string, now: number = Date.now()) {
  let b = buckets.get(key);
  if (!b) {
    b = { failures: [] };
    buckets.set(key, b);
  }
  b.failures.push(now);
}

export function clearAttempts(key: string) {
  buckets.delete(key);
}

/** Test-only: nuke all state. */
export function _resetForTests() {
  buckets.clear();
}

/**
 * Extract a stable client identifier from request headers.
 * Honors X-Forwarded-For (first hop) when present — ServiceBay sits behind
 * NPM in production. Falls back to a literal "unknown" so absence still
 * collapses to a single bucket rather than bypassing the limiter.
 */
export function clientKeyFromHeaders(headers: Headers | Record<string, string | string[] | undefined>): string {
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const v = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(v)) return v[0];
    return v;
  };
  const xff = get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}
