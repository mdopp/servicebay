// Disk-import engine — persistent catalog (issue #1693).
//
// A small SQLite catalog keyed by (sha256, target). It records what has already
// been imported so a SECOND disk becomes a delta run: anything whose content +
// destination already exists is skipped. The DB file PATH is a constructor
// param — no hardcoded host paths, no DATA_DIR coupling. `:memory:` is valid and
// used by the tests.

import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

/** One persisted catalog row. */
export interface CatalogEntry {
  /** Content hash (sha256 hex). */
  sha256: string;
  /** Target path relative to `file-share/data/` this content was written to. */
  target: string;
  /** Original source path (informational — last writer wins). */
  sourcePath: string;
  /** File size in bytes. */
  size: number;
  /** When this entry was recorded, epoch ms. */
  importedAtMs: number;
}

interface CatalogRow {
  sha256: string;
  target: string;
  source_path: string;
  size: number;
  imported_at_ms: number;
}

function rowToEntry(row: CatalogRow): CatalogEntry {
  return {
    sha256: row.sha256,
    target: row.target,
    sourcePath: row.source_path,
    size: row.size,
    importedAtMs: row.imported_at_ms,
  };
}

/**
 * Persistent import catalog. Open with a file path (created if missing) or
 * `:memory:` for ephemeral use. Close when done so the file handle is released.
 */
export class ImportCatalog {
  private db: BetterSqliteDatabase;

  constructor(dbPath: string) {
    // Runtime require keeps better-sqlite3 (a native addon) out of any client
    // bundle, matching the rest of the codebase (logger.ts, rateLimit.ts).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    this.db = new Database(dbPath) as BetterSqliteDatabase;
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS import_catalog (
        sha256          TEXT NOT NULL,
        target          TEXT NOT NULL,
        source_path     TEXT NOT NULL,
        size            INTEGER NOT NULL,
        imported_at_ms  INTEGER NOT NULL,
        PRIMARY KEY (sha256, target)
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_sha    ON import_catalog(sha256);
      CREATE INDEX IF NOT EXISTS idx_catalog_target ON import_catalog(target);
    `);
  }

  /** True if this exact content has already been written to this target. */
  has(sha256: string, target: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM import_catalog WHERE sha256 = ? AND target = ?')
      .get(sha256, target);
    return row !== undefined;
  }

  /** Look up the entry for (sha256, target), or `undefined` if absent. */
  get(sha256: string, target: string): CatalogEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM import_catalog WHERE sha256 = ? AND target = ?')
      .get(sha256, target) as CatalogRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /** All catalog rows that hold this content hash (any target). */
  findBySha(sha256: string): CatalogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM import_catalog WHERE sha256 = ? ORDER BY target ASC')
      .all(sha256) as CatalogRow[];
    return rows.map(rowToEntry);
  }

  /** The catalog row for a given target path, or `undefined`. */
  getByTarget(target: string): CatalogEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM import_catalog WHERE target = ?')
      .get(target) as CatalogRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /** Insert or update the (sha256, target) entry. Idempotent. */
  upsert(entry: CatalogEntry): void {
    this.db
      .prepare(`
        INSERT INTO import_catalog (sha256, target, source_path, size, imported_at_ms)
        VALUES (@sha256, @target, @sourcePath, @size, @importedAtMs)
        ON CONFLICT(sha256, target) DO UPDATE SET
          source_path    = excluded.source_path,
          size           = excluded.size,
          imported_at_ms = excluded.imported_at_ms
      `)
      .run(entry);
  }

  /** Total number of cataloged entries. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM import_catalog').get() as { n: number };
    return row.n;
  }

  /** Release the underlying file handle. */
  close(): void {
    this.db.close();
  }
}
