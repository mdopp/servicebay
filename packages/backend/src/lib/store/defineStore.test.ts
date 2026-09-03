/**
 * `defineStore` — versioned durable JSON stores (#2739).
 *
 * The three promises the mechanism makes, one describe block each:
 *   1. a file at v(n-1) is pulled forward through the registered migrations;
 *   2. a file at v(n+1) is refused loudly — on read AND on write;
 *   3. writes stay atomic (the #2414 tmp → fsync → rename contract), proven by
 *      injecting a fault into the rename and showing the previous file is
 *      still intact with no temp-file residue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { z } from 'zod';

import { defineStore, StoreVersionError, StoreShapeError } from './defineStore';

const TEST_DIR = path.join(os.tmpdir(), `sb-define-store-${process.pid}`);
const FILE = path.join(TEST_DIR, 'widgets.json');

/** A store whose shape grew twice: v1 rows had `name`, v2 added `enabled`,
 *  v3 renamed `name` → `label`. Both steps are registered, so a v1 file on a
 *  box has to walk 1 → 2 → 3 to be readable by this build. */
const WidgetSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
});

const widgetStore = defineStore<z.infer<typeof WidgetSchema>[]>({
  name: 'widgets',
  file: () => FILE,
  version: 3,
  schema: z.array(WidgetSchema),
  migrations: {
    // v0 = the bare, pre-defineStore array a box already has on disk.
    1: previous => (Array.isArray(previous) ? previous : []),
    2: previous => (previous as Record<string, unknown>[]).map(w => ({ ...w, enabled: true })),
    3: previous => (previous as Record<string, unknown>[]).map(({ name, ...rest }) => ({ ...rest, label: name })),
  },
  fallback: () => [],
});

const envelope = (version: number, data: unknown, name = 'widgets') =>
  JSON.stringify({ __store: name, version, data }, null, 2);

beforeEach(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
  await fs.rm(FILE, { force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('defineStore — reading an older file migrates it forward', () => {
  it('pulls a v(n-1) file through the registered migration to v(n)', async () => {
    await fs.writeFile(FILE, envelope(2, [{ id: 'a', name: 'Alpha', enabled: false }]));

    expect(await widgetStore.read()).toEqual([{ id: 'a', label: 'Alpha', enabled: false }]);
  });

  it('walks every step when the file is several versions behind', async () => {
    await fs.writeFile(FILE, envelope(1, [{ id: 'a', name: 'Alpha' }]));

    // 1 → 2 adds `enabled`, 2 → 3 renames `name` → `label`.
    expect(await widgetStore.read()).toEqual([{ id: 'a', label: 'Alpha', enabled: true }]);
  });

  it('treats an unversioned pre-adoption file as version 0', async () => {
    // What every existing box has on disk before its store is adopted: the
    // bare payload, no envelope. migrations[1] is what claims it.
    await fs.writeFile(FILE, JSON.stringify([{ id: 'a', name: 'Alpha' }]));

    expect(await widgetStore.read()).toEqual([{ id: 'a', label: 'Alpha', enabled: true }]);
  });

  it('re-stamps the file at the current version when it is written back', async () => {
    await fs.writeFile(FILE, JSON.stringify([{ id: 'a', name: 'Alpha' }]));

    await widgetStore.write(await widgetStore.read());

    const onDisk = JSON.parse(await fs.readFile(FILE, 'utf-8'));
    expect(onDisk.__store).toBe('widgets');
    expect(onDisk.version).toBe(3);
    expect(onDisk.data).toEqual([{ id: 'a', label: 'Alpha', enabled: true }]);
  });

  it('reads the fallback for a file that does not exist', async () => {
    expect(await widgetStore.read()).toEqual([]);
    expect(widgetStore.readSync()).toEqual([]);
  });

  it('names the missing step when a migration is not registered', async () => {
    const gapped = defineStore<{ id: string }[]>({
      name: 'gapped',
      file: () => path.join(TEST_DIR, 'gapped.json'),
      version: 2,
      schema: z.array(z.object({ id: z.string() })),
      migrations: { 1: previous => previous }, // no step to 2
      fallback: () => [],
    });
    await fs.writeFile(path.join(TEST_DIR, 'gapped.json'), envelope(1, [{ id: 'a' }], 'gapped'));

    await expect(gapped.read()).rejects.toThrow(StoreShapeError);
    await expect(gapped.read()).rejects.toThrow(/no migration to version 2 is registered/);
  });

  it('refuses a file that belongs to a different store', async () => {
    await fs.writeFile(FILE, envelope(3, [], 'some-other-store'));

    await expect(widgetStore.read()).rejects.toThrow(/written by store "some-other-store"/);
  });

  it('throws when the migrated value does not satisfy the schema', async () => {
    await fs.writeFile(FILE, envelope(3, [{ id: 'a', label: 'Alpha' }])); // `enabled` missing

    await expect(widgetStore.read()).rejects.toThrow(StoreShapeError);
    await expect(widgetStore.read()).rejects.toThrow(/does not match the version 3 schema/);
  });

  it('degrades to the fallback for a byte-corrupt file (not a downgrade)', async () => {
    await fs.writeFile(FILE, '{ this is not json');

    expect(await widgetStore.read()).toEqual([]);
  });
});

describe('defineStore — a newer file is refused loudly', () => {
  it('errors clearly when reading a v(n+1) file', async () => {
    await fs.writeFile(FILE, envelope(4, [{ id: 'a', label: 'Alpha', enabled: true }]));

    await expect(widgetStore.read()).rejects.toThrow(StoreVersionError);
    // The message has to be actionable on a box, so assert its substance:
    // which store, which file, both versions, and what to do.
    await expect(widgetStore.read()).rejects.toThrow(/Store "widgets"/);
    await expect(widgetStore.read()).rejects.toThrow(/is at version 4/);
    await expect(widgetStore.read()).rejects.toThrow(/only understands version 3/);
    await expect(widgetStore.read()).rejects.toThrow(/Upgrade ServiceBay/);
  });

  it('errors on the sync read path too', async () => {
    await fs.writeFile(FILE, envelope(4, []));

    expect(() => widgetStore.readSync()).toThrow(StoreVersionError);
  });

  it('refuses to OVERWRITE a newer file — the downgrade must not reset data', async () => {
    const newer = envelope(4, [{ id: 'a', label: 'Alpha', enabled: true }]);
    await fs.writeFile(FILE, newer);

    await expect(widgetStore.write([])).rejects.toThrow(StoreVersionError);
    expect(await fs.readFile(FILE, 'utf-8')).toBe(newer);

    expect(() => widgetStore.writeSync([])).toThrow(StoreVersionError);
    expect(await fs.readFile(FILE, 'utf-8')).toBe(newer);
  });

  it('does not refuse a file at the current version', async () => {
    await fs.writeFile(FILE, envelope(3, [{ id: 'a', label: 'Alpha', enabled: true }]));

    await expect(widgetStore.write([{ id: 'b', label: 'Beta', enabled: false }])).resolves.toBeUndefined();
    expect(await widgetStore.read()).toEqual([{ id: 'b', label: 'Beta', enabled: false }]);
  });
});

describe('defineStore — writes stay atomic under fault injection (#2414)', () => {
  const previous = [{ id: 'a', label: 'Alpha', enabled: true }];

  it('leaves the previous file intact when the async write dies mid-flight', async () => {
    await widgetStore.write(previous);
    const before = await fs.readFile(FILE, 'utf-8');

    // The crash lands after the temp file is written, before the rename —
    // the exact window a bare fs.writeFile would have left the target
    // truncated in.
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('ENOSPC: simulated crash'));

    await expect(widgetStore.write([{ id: 'b', label: 'Beta', enabled: false }])).rejects.toThrow(/simulated crash/);

    expect(await fs.readFile(FILE, 'utf-8')).toBe(before);
    expect(await widgetStore.read()).toEqual(previous);
    expect(await leftoverTempFiles()).toEqual([]);
  });

  it('leaves the previous file intact when the sync write dies mid-flight', async () => {
    widgetStore.writeSync(previous);
    const before = fsSync.readFileSync(FILE, 'utf-8');

    vi.spyOn(fsSync, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EIO: simulated crash');
    });

    expect(() => widgetStore.writeSync([{ id: 'b', label: 'Beta', enabled: false }])).toThrow(/simulated crash/);

    expect(fsSync.readFileSync(FILE, 'utf-8')).toBe(before);
    expect(widgetStore.readSync()).toEqual(previous);
    expect(await leftoverTempFiles()).toEqual([]);
  });
});

/** Temp files atomicWrite leaves behind if it fails to clean up after itself. */
async function leftoverTempFiles(): Promise<string[]> {
  const entries = await fs.readdir(TEST_DIR);
  return entries.filter(e => e.endsWith('.tmp'));
}
