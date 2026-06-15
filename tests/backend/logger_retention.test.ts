// @vitest-environment node
/**
 * Log-retention prune tests (#1869).
 *
 * The Logger singleton binds to process.cwd()/data/logs.db at import time,
 * so we exercise the extracted, pure `pruneLogsDb(db, days, now)` helper
 * against a real better-sqlite3 DB on disk (matching the production schema
 * and timestamp format). This is the actual code the Logger constructor
 * (startup prune) and insertLog (lazy periodic prune) call.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { pruneLogsDb, LOG_RETENTION_DAYS } from '@/lib/logger';

// Value import via require to mirror production (logger.ts / rateLimit.ts)
// and keep knip from flagging better-sqlite3 as an unlisted root dependency
// — it's a backend-package dep, not a root one.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database: typeof BetterSqlite3 = require('better-sqlite3');

const TABLE = `
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL,
    tag TEXT NOT NULL,
    message TEXT NOT NULL,
    args TEXT,
    trace_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
`;

// Same format the Logger writes: ISO with the T separator -> space, Z removed.
function ts(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

const NOW = new Date('2026-06-15T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

let dir: string;
let dbPath: string;
let db: InstanceType<typeof Database>;

function open(): InstanceType<typeof Database> {
  const d = new Database(dbPath);
  d.pragma('journal_mode = WAL');
  d.exec(TABLE);
  return d;
}

function seed(d: InstanceType<typeof Database>, when: Date, count = 1) {
  const stmt = d.prepare('INSERT INTO logs (timestamp, level, tag, message) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < count; i++) stmt.run(ts(when), 'info', 'test', `msg-${i}`);
}

function rowCount(d: InstanceType<typeof Database>): number {
  return (d.prepare('SELECT COUNT(*) AS c FROM logs').get() as { c: number }).c;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-logretention-'));
  dbPath = path.join(dir, 'logs.db');
  db = open();
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('pruneLogsDb (#1869)', () => {
  it('deletes rows older than the retention window, keeps recent ones (prune-threshold)', () => {
    seed(db, daysAgo(30), 5); // well outside the window
    seed(db, daysAgo(8), 3); // just outside (default 7d)
    seed(db, daysAgo(1), 4); // inside
    seed(db, NOW, 2); // inside
    expect(rowCount(db)).toBe(14);

    const deleted = pruneLogsDb(db, LOG_RETENTION_DAYS, NOW);

    expect(deleted).toBe(8); // 5 + 3 old rows removed
    expect(rowCount(db)).toBe(6); // 4 + 2 recent rows kept
    // No surviving row is older than the cutoff.
    const oldest = (db.prepare('SELECT MIN(timestamp) AS m FROM logs').get() as { m: string }).m;
    expect(oldest >= ts(daysAgo(LOG_RETENTION_DAYS))).toBe(true);
  });

  it('startup prune on an existing pile removes the backlog', () => {
    // Simulate the existing multi-GB pile: many old rows.
    seed(db, daysAgo(20), 1000);
    seed(db, NOW, 5);
    const deleted = pruneLogsDb(db, LOG_RETENTION_DAYS, NOW);
    expect(deleted).toBe(1000);
    expect(rowCount(db)).toBe(5);
  });

  const pageCount = (d: InstanceType<typeof Database>) =>
    d.pragma('page_count', { simple: true }) as number;
  const freelist = (d: InstanceType<typeof Database>) =>
    d.pragma('freelist_count', { simple: true }) as number;

  it('VACUUM runs after a prune so freed pages are reclaimed', () => {
    // Build a fat DB of old rows, checkpoint so the data lands in the main
    // file. After DELETE the pages sit on the freelist (file does not shrink
    // on DELETE alone — the bug); only the VACUUM in pruneLogsDb rewrites the
    // DB and drops the page count back down.
    seed(db, daysAgo(20), 20000);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const before = pageCount(db);
    expect(before).toBeGreaterThan(100);

    const deleted = pruneLogsDb(db, LOG_RETENTION_DAYS, NOW);
    expect(deleted).toBe(20000);

    // VACUUM reclaimed the freed pages: page count collapsed and the
    // freelist is empty.
    expect(pageCount(db)).toBeLessThan(before / 10);
    expect(freelist(db)).toBe(0);
  });

  it('does not VACUUM when nothing is old (no-op prune leaves the DB untouched)', () => {
    seed(db, NOW, 5000);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const before = pageCount(db);

    const deleted = pruneLogsDb(db, LOG_RETENTION_DAYS, NOW);

    // No rows deleted -> VACUUM skipped (it is expensive) -> page count and
    // row count unchanged.
    expect(deleted).toBe(0);
    expect(pageCount(db)).toBe(before);
    expect(rowCount(db)).toBe(5000);
  });

  it('keeps logs.db bounded across many insert+prune cycles', () => {
    // Each "day" we insert a batch then prune; the row count must stay
    // bounded to roughly the retention window's worth, never growing
    // unbounded.
    for (let day = 0; day < 60; day++) {
      const when = new Date(NOW.getTime() - (60 - day) * 24 * 60 * 60 * 1000);
      seed(db, when, 100);
      pruneLogsDb(db, LOG_RETENTION_DAYS, when);
    }
    // At the end only the last ~7 days of inserts survive (<= 8 batches).
    expect(rowCount(db)).toBeLessThanOrEqual(8 * 100);
    expect(rowCount(db)).toBeGreaterThan(0);
  });
});
