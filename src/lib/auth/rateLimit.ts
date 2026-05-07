// Sliding-window login rate limiter, persisted to SQLite so failed attempts
// survive process restarts (the agent updater restarts the server nightly,
// which would otherwise zero a brute-forcer's progress).
//
// Storage is opt-in: in environments where SQLite cannot be initialized
// (e.g. unit tests with no writable DATA_DIR) the limiter falls back to a
// process-local Map so its behavior is unchanged from the v1 implementation.

import path from 'path';
import { DATA_DIR } from '../dirs';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

interface BucketRow { ts: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stmt = { all: (...args: any[]) => unknown[]; run: (...args: any[]) => unknown };
interface DBLike {
  prepare: (sql: string) => Stmt;
  exec: (sql: string) => void;
  pragma: (sql: string) => unknown;
}

let db: DBLike | null = null;
const memoryFallback = new Map<string, number[]>();

function tryOpenDb(): DBLike | null {
  if (db) return db;
  if (typeof window !== 'undefined') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const inst = new Database(path.join(DATA_DIR, 'auth.db')) as DBLike;
    inst.pragma('journal_mode = WAL');
    inst.exec(`
      CREATE TABLE IF NOT EXISTS rate_limit_attempts (
        key TEXT NOT NULL,
        ts  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rl_key ON rate_limit_attempts(key);
      CREATE INDEX IF NOT EXISTS idx_rl_ts  ON rate_limit_attempts(ts);
    `);
    db = inst;
    return db;
  } catch {
    return null;
  }
}

function getFailuresFromStore(key: string, cutoff: number): number[] {
  const inst = tryOpenDb();
  if (!inst) {
    const arr = memoryFallback.get(key) ?? [];
    return arr.filter(t => t >= cutoff);
  }
  const rows = inst
    .prepare('SELECT ts FROM rate_limit_attempts WHERE key = ? AND ts >= ? ORDER BY ts ASC')
    .all(key, cutoff) as BucketRow[];
  return rows.map(r => r.ts);
}

function addFailureToStore(key: string, ts: number) {
  const inst = tryOpenDb();
  if (!inst) {
    const arr = memoryFallback.get(key) ?? [];
    arr.push(ts);
    memoryFallback.set(key, arr);
    return;
  }
  inst.prepare('INSERT INTO rate_limit_attempts (key, ts) VALUES (?, ?)').run(key, ts);
}

function clearStoreKey(key: string) {
  const inst = tryOpenDb();
  if (!inst) {
    memoryFallback.delete(key);
    return;
  }
  inst.prepare('DELETE FROM rate_limit_attempts WHERE key = ?').run(key);
}

function pruneOldStore(cutoff: number) {
  const inst = tryOpenDb();
  if (!inst) {
    for (const [k, arr] of memoryFallback) {
      const kept = arr.filter(t => t >= cutoff);
      if (kept.length === 0) memoryFallback.delete(k);
      else memoryFallback.set(k, kept);
    }
    return;
  }
  inst.prepare('DELETE FROM rate_limit_attempts WHERE ts < ?').run(cutoff);
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec?: number;
  recentFailures: number;
}

/**
 * Check whether an attempt from `key` is currently allowed.
 * Does NOT mutate state — call recordFailure / clearAttempts after handling.
 */
export function checkRateLimit(
  key: string,
  now: number = Date.now(),
  windowMs: number = WINDOW_MS,
  maxFailures: number = MAX_FAILURES,
): RateLimitDecision {
  const cutoff = now - windowMs;
  // Opportunistic prune: cheap when the table is small.
  pruneOldStore(cutoff);
  const failures = getFailuresFromStore(key, cutoff);
  if (failures.length >= maxFailures) {
    const oldest = failures[0];
    const retryAfterMs = (oldest + windowMs) - now;
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      recentFailures: failures.length,
    };
  }
  return { allowed: true, recentFailures: failures.length };
}

export function recordFailure(key: string, now: number = Date.now()) {
  addFailureToStore(key, now);
}

export function clearAttempts(key: string) {
  clearStoreKey(key);
}

/** Test-only: nuke all state. */
export function _resetForTests() {
  memoryFallback.clear();
  const inst = tryOpenDb();
  if (inst) inst.exec('DELETE FROM rate_limit_attempts');
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
