// Disk-import engine — persistent catalog (issue #1693).
//
// A small SQLite catalog keyed by (sha256, area, target). It records what has
// already been imported so a SECOND disk becomes a delta run: anything whose
// content + destination AREA + target already exists is skipped. The `area`
// (owner-derived destination area, #1912) scopes dedup so a private area dedups
// within itself while `shared` merges across users — the SAME bytes can live
// once per area intentionally. `area` defaults to `'shared'` (the pre-#1912
// behaviour, so existing single-area rows are unaffected). The DB file PATH is a
// constructor param — no hardcoded host paths, no DATA_DIR coupling. `:memory:`
// is valid and used by the tests.

import type { Database as BetterSqliteDatabase } from 'better-sqlite3';

/** The default destination area when no owner-derived area is supplied. */
export const DEFAULT_AREA = 'shared';

/** One persisted catalog row. */
export interface CatalogEntry {
  /** Content hash (sha256 hex). */
  sha256: string;
  /**
   * Destination area (owner-derived, #1912): `shared` or a box-user id. Scopes
   * dedup — the same content can be cataloged once per area. Defaults to
   * `'shared'` when omitted, matching pre-#1912 rows.
   */
  area?: string;
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
  area: string;
  target: string;
  source_path: string;
  size: number;
  imported_at_ms: number;
}

function rowToEntry(row: CatalogRow): CatalogEntry {
  return {
    sha256: row.sha256,
    area: row.area,
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
    // Bring a pre-existing (possibly pre-#1912) catalog up to the current shape
    // BEFORE creating the table or any `area`-referencing index — a fresh DB is a
    // no-op here. CREATE TABLE IF NOT EXISTS never touches an existing table, so
    // migration is the only path that fixes an old one.
    this.selfHealSchema();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS import_catalog (
        sha256          TEXT NOT NULL,
        area            TEXT NOT NULL DEFAULT 'shared',
        target          TEXT NOT NULL,
        source_path     TEXT NOT NULL,
        size            INTEGER NOT NULL,
        imported_at_ms  INTEGER NOT NULL,
        PRIMARY KEY (sha256, area, target)
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_sha         ON import_catalog(sha256);
      CREATE INDEX IF NOT EXISTS idx_catalog_area_target ON import_catalog(area, target);
    `);
  }

  /**
   * Forward-only, idempotent self-migration for a catalog created before #1912
   * (issue #1940). The catalog is a PERSISTENT SQLite on the box: #1912 added
   * `area TEXT NOT NULL DEFAULT 'shared'` to the dedup key AND moved the PRIMARY
   * KEY from `(sha256, target)` to `(sha256, area, target)`. A pre-#1912 catalog
   * has neither, so the area-scoped dedup queries throw `no such column: area`
   * and the upsert's `ON CONFLICT(sha256, area, target)` finds no matching key.
   *
   * SQLite's `ALTER TABLE ADD COLUMN` can backfill the column but cannot change a
   * PRIMARY KEY, so a stale-PK catalog needs the full table-rebuild ("12-step")
   * pattern. We therefore: (1) skip entirely if the table is absent (fresh DB —
   * CREATE TABLE in the ctor makes the current shape); (2) rebuild if the live
   * PRIMARY KEY differs from the current one, copying every row and backfilling
   * the default `area` for legacy rows; (3) otherwise ADD COLUMN any columns the
   * engine queries that a same-PK-but-older table is missing. The rebuilt/altered
   * table is byte-identical to a freshly created one (same column types/defaults,
   * same PK), so a migrated and a fresh catalog converge.
   */
  private selfHealSchema(): void {
    const tableExists =
      this.db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='import_catalog'`)
        .get() !== undefined;
    if (!tableExists) return; // Fresh DB — the ctor's CREATE TABLE makes the current shape.

    const cols = this.db.prepare('PRAGMA table_info(import_catalog)').all() as {
      name: string;
      pk: number;
    }[];
    const existing = new Set(cols.map(c => c.name));
    // The live PRIMARY KEY, in declared order.
    const livePk = cols
      .filter(c => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map(c => c.name)
      .join(',');
    const wantPk = 'sha256,area,target';

    if (livePk !== wantPk) {
      // PRIMARY KEY changed (pre-#1912). ADD COLUMN can't change a PK, so rebuild.
      this.rebuildWithCurrentSchema(existing.has('area'));
      return; // Rebuilt table already has every current column.
    }

    // Same PK but possibly missing a later-added column. (column → DDL fragment)
    // for every column added after the #1912 shape; defaults are constants so
    // SQLite can backfill existing rows. Keep byte-identical to CREATE TABLE.
    const addedColumns: ReadonlyArray<readonly [string, string]> = [
      ['area', `TEXT NOT NULL DEFAULT 'shared'`], // #1912 — owner-derived dedup area
    ];
    for (const [name, ddl] of addedColumns) {
      if (existing.has(name)) continue;
      // Hardcoded column DDL (not user input); SQLite db.exec, not a shell call.
      this.db.exec('ALTER TABLE import_catalog ADD COLUMN ' + name + ' ' + ddl);
    }
  }

  /**
   * SQLite "12-step" table rebuild used when the live PRIMARY KEY differs from the
   * current `(sha256, area, target)` (a pre-#1912 catalog keyed on `(sha256,
   * target)`). Copies every row into a freshly created current-shape table inside
   * a transaction, backfilling `area` to the pre-#1912 default `'shared'` for
   * legacy rows that lack the column, then swaps the table in. `INSERT OR IGNORE`
   * collapses any rows that would collide under the new wider key.
   */
  private rebuildWithCurrentSchema(hasArea: boolean): void {
    // The area source for the copy: the legacy column when present, else the
    // pre-#1912 default. Both branches are hardcoded SQL (not user input); this
    // is a SQLite db.exec, not a shell executor.
    const areaExpr = hasArea ? 'area' : `'shared'`;
    const copySql =
      'INSERT OR IGNORE INTO import_catalog__new ' +
      '(sha256, area, target, source_path, size, imported_at_ms) ' +
      'SELECT sha256, ' +
      areaExpr +
      ', target, source_path, size, imported_at_ms FROM import_catalog;';
    this.db.exec('BEGIN');
    try {
      this.db.exec(`
        CREATE TABLE import_catalog__new (
          sha256          TEXT NOT NULL,
          area            TEXT NOT NULL DEFAULT 'shared',
          target          TEXT NOT NULL,
          source_path     TEXT NOT NULL,
          size            INTEGER NOT NULL,
          imported_at_ms  INTEGER NOT NULL,
          PRIMARY KEY (sha256, area, target)
        );
      `);
      this.db.exec(copySql);
      this.db.exec('DROP TABLE import_catalog;');
      this.db.exec('ALTER TABLE import_catalog__new RENAME TO import_catalog;');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** True if this exact content has already been written to this area+target. */
  has(sha256: string, target: string, area: string = DEFAULT_AREA): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM import_catalog WHERE sha256 = ? AND area = ? AND target = ?')
      .get(sha256, area, target);
    return row !== undefined;
  }

  /** Look up the entry for (sha256, area, target), or `undefined` if absent. */
  get(sha256: string, target: string, area: string = DEFAULT_AREA): CatalogEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM import_catalog WHERE sha256 = ? AND area = ? AND target = ?')
      .get(sha256, area, target) as CatalogRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /** All catalog rows that hold this content hash (any area/target). */
  findBySha(sha256: string): CatalogEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM import_catalog WHERE sha256 = ? ORDER BY area ASC, target ASC')
      .all(sha256) as CatalogRow[];
    return rows.map(rowToEntry);
  }

  /**
   * The catalog row for a given target path within an area, or `undefined`.
   * Dedup is scoped to the area: a target in `shared` and the same target in a
   * user area are distinct rows.
   */
  getByTarget(target: string, area: string = DEFAULT_AREA): CatalogEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM import_catalog WHERE area = ? AND target = ?')
      .get(area, target) as CatalogRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /** Insert or update the (sha256, area, target) entry. Idempotent. */
  upsert(entry: CatalogEntry): void {
    this.db
      .prepare(`
        INSERT INTO import_catalog (sha256, area, target, source_path, size, imported_at_ms)
        VALUES (@sha256, @area, @target, @sourcePath, @size, @importedAtMs)
        ON CONFLICT(sha256, area, target) DO UPDATE SET
          source_path    = excluded.source_path,
          size           = excluded.size,
          imported_at_ms = excluded.imported_at_ms
      `)
      .run({ ...entry, area: entry.area ?? DEFAULT_AREA });
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
