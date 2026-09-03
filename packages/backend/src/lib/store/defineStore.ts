/**
 * Versioned durable JSON stores (#2739).
 *
 * ServiceBay keeps ~28 small JSON documents under `DATA_DIR`. Writing them is
 * crash-safe (#2414 — every durable-state module goes through
 * {@link atomicWriteFile}/{@link atomicWriteFileSync}), but **changing their
 * shape** had no mechanism at all: a shape change was either caught ad hoc in
 * the reader or not at all, and the one `CURRENT_SCHEMA_VERSION` ledger that
 * tried to solve it never actually branched on anything and was removed
 * (#2725). Do not resurrect that pattern — a version number nobody migrates
 * on is decoration.
 *
 * `defineStore` is the replacement. A store declares its `name`, its `schema`,
 * its current `version` and the `migrations` that reach it. On read:
 *
 *   - a file at an **older** version is pulled forward through every
 *     registered migration, in order, and only then validated;
 *   - a file at a **newer** version is **refused loudly** — a downgraded build
 *     must never silently overwrite (and so discard) data a newer build wrote;
 *   - a **missing** file yields the store's `fallback()`;
 *   - a file that predates `defineStore` (no envelope) is version **0**, so
 *     adopting an existing store means registering a `migrations[1]` that
 *     accepts what boxes already have on disk.
 *
 * Writes keep the #2414 guarantee: the payload is wrapped in the envelope and
 * handed to `atomicWriteFile`/`atomicWriteFileSync` (tmp → fsync → rename), so
 * a crash mid-write leaves the previous file intact. Before writing, the store
 * re-checks the on-disk version and refuses to overwrite a newer file — the
 * read guard alone would not stop a downgraded build from clobbering data on
 * the next save.
 *
 * On-disk envelope:
 *
 * ```json
 * { "__store": "network-edges", "version": 1, "data": [ … ] }
 * ```
 *
 * The decision is ADR 0016 (`assists/adr-0016-durable-stores-are-versioned-and-forward-only.md`).
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { z } from 'zod';
import { atomicWriteFile, atomicWriteFileSync } from '../util/atomicWrite';
import { logger } from '../logger';

const TAG = 'store';

/** Marker key that identifies a file as `defineStore`-written. */
const ENVELOPE_MARKER = '__store';

/**
 * The version assigned to a file that carries no envelope — i.e. every store
 * file that already exists on a box today. Adoption therefore always starts at
 * `migrations[1]`, which is the one place a store says what its pre-adoption
 * on-disk shape was.
 */
const UNVERSIONED = 0;

/**
 * The on-disk file is at a version this build does not understand.
 *
 * Thrown on read *and* on write. Never swallowed by the store: the whole point
 * is that a downgrade fails visibly instead of resetting the operator's data.
 */
export class StoreVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreVersionError';
  }
}

/**
 * The file's content does not match what the store expects: it belongs to a
 * different store, a migration step is missing, or the migrated value fails
 * the schema. All three are bugs (in the migration chain or in something that
 * hand-edited the file), not conditions to degrade past silently.
 */
export class StoreShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreShapeError';
  }
}

/** Upgrades the payload from version `n-1` to version `n`. Forward only. */
type StoreMigration = (previous: unknown) => unknown;

export interface StoreDefinition<T> {
  /** Stable identity, stamped into the envelope. Not the file name. */
  name: string;
  /** Absolute path, or a thunk when it depends on a lazily-resolved DATA_DIR. */
  file: string | (() => string);
  /** The version this build reads and writes. */
  version: number;
  /** Validates the payload *after* migration. */
  schema: z.ZodType<T>;
  /** `migrations[n]` upgrades v(n-1) → v(n). Every step from 1..version must exist. */
  migrations: Record<number, StoreMigration>;
  /** Value for a store whose file does not exist (or is unreadable). */
  fallback: () => T;
}

export interface VersionedStore<T> {
  readonly name: string;
  readonly version: number;
  /** Resolve the store's file path (thunk-aware). */
  path(): string;
  /** Parse + migrate + validate a raw file body. Throws; does not fall back. */
  decode(raw: string): T;
  /** Wrap a payload in the current envelope. */
  encode(value: T): string;
  read(): Promise<T>;
  readSync(): T;
  write(value: T): Promise<void>;
  writeSync(value: T): void;
}

interface Envelope {
  version: number;
  data: unknown;
  [ENVELOPE_MARKER]: unknown;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ENVELOPE_MARKER in value &&
    typeof (value as Envelope).version === 'number'
  );
}

/** Compact, human-readable rendering of a zod failure for the thrown message. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/** The version an already-parsed JSON value claims, or 0 when unversioned. */
function versionOf(parsed: unknown): number {
  return isEnvelope(parsed) ? parsed.version : UNVERSIONED;
}

class Store<T> implements VersionedStore<T> {
  constructor(private readonly def: StoreDefinition<T>) {}

  get name(): string { return this.def.name; }
  get version(): number { return this.def.version; }

  path(): string {
    return typeof this.def.file === 'string' ? this.def.file : this.def.file();
  }

  private newerFileMessage(fileVersion: number, file: string): string {
    return (
      `Store "${this.def.name}": ${file} is at version ${fileVersion}, but this build of ` +
      `ServiceBay only understands version ${this.def.version}. Refusing to read or overwrite ` +
      `it — a newer ServiceBay wrote this file, and continuing would discard data. Upgrade ` +
      `ServiceBay (or restore a backup written by this version) instead.`
    );
  }

  decode(raw: string): T {
    const parsed: unknown = JSON.parse(raw);
    const file = this.path();

    if (isEnvelope(parsed) && parsed[ENVELOPE_MARKER] !== this.def.name) {
      throw new StoreShapeError(
        `Store "${this.def.name}": ${file} was written by store ` +
        `"${String(parsed[ENVELOPE_MARKER])}". Refusing to read another store's file.`,
      );
    }

    const fileVersion = versionOf(parsed);
    if (fileVersion > this.def.version) {
      throw new StoreVersionError(this.newerFileMessage(fileVersion, file));
    }

    const data = this.migrate(isEnvelope(parsed) ? parsed.data : parsed, fileVersion, file);
    const result = this.def.schema.safeParse(data);
    if (!result.success) {
      throw new StoreShapeError(
        `Store "${this.def.name}": ${file} does not match the version ${this.def.version} schema ` +
        `after migration from version ${fileVersion} — ${describeIssues(result.error)}`,
      );
    }
    return result.data;
  }

  /** Walk the payload from `fileVersion` up to the current version, one
   *  registered step at a time. A gap is an error, never a skip. */
  private migrate(payload: unknown, fileVersion: number, file: string): unknown {
    let data = payload;
    for (let v = fileVersion + 1; v <= this.def.version; v++) {
      const migration = this.def.migrations[v];
      if (!migration) {
        throw new StoreShapeError(
          `Store "${this.def.name}": ${file} is at version ${fileVersion} and no migration to ` +
          `version ${v} is registered. Migrations are forward-only and every step from 1 to ` +
          `${this.def.version} must exist.`,
        );
      }
      data = migration(data);
    }
    return data;
  }

  encode(value: T): string {
    return JSON.stringify(
      { [ENVELOPE_MARKER]: this.def.name, version: this.def.version, data: value },
      null,
      2,
    );
  }

  /**
   * Turn a raw file body into a value, degrading only where degrading is safe:
   * unparseable JSON reads as the fallback (a byte-corrupt file is not a
   * downgrade), while a version or shape error propagates.
   */
  private decodeTolerantly(raw: string, file: string): T {
    try {
      return this.decode(raw);
    } catch (e) {
      if (e instanceof StoreVersionError || e instanceof StoreShapeError) throw e;
      logger.warn(TAG, `${this.def.name}: could not parse ${file}, using the empty default: ${String(e)}`);
      return this.def.fallback();
    }
  }

  /** Refuse to overwrite a file written by a newer build (the downgrade guard). */
  private assertNotNewer(raw: string | null, file: string): void {
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // unreadable → nothing to protect
    }
    if (versionOf(parsed) > this.def.version) {
      throw new StoreVersionError(this.newerFileMessage(versionOf(parsed), file));
    }
  }

  async read(): Promise<T> {
    const file = this.path();
    const raw = await readRaw(file);
    return raw === null ? this.def.fallback() : this.decodeTolerantly(raw, file);
  }

  readSync(): T {
    const file = this.path();
    const raw = readRawSync(file);
    return raw === null ? this.def.fallback() : this.decodeTolerantly(raw, file);
  }

  async write(value: T): Promise<void> {
    const file = this.path();
    this.assertNotNewer(await readRaw(file), file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, this.encode(value));
  }

  writeSync(value: T): void {
    const file = this.path();
    this.assertNotNewer(readRawSync(file), file);
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, this.encode(value));
  }
}

async function readRaw(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
}

function readRawSync(file: string): string | null {
  try {
    return fsSync.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** Declare a versioned, atomically-written durable store. See the module doc. */
export function defineStore<T>(def: StoreDefinition<T>): VersionedStore<T> {
  return new Store(def);
}
