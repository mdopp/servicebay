import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseWorkerArgs,
  resolveServiceDataDir,
  applyCollectorRemap,
  runWorker,
  WorkerArgError,
  type WorkerIO,
} from './main';
import type { ServiceBackupManifest } from '@servicebay/backup-manifest';

/**
 * The worker owns NO manifest table since #2858 slice C — servicebay resolves
 * the templates' `servicebay.backup` declarations and hands the result over on
 * the command line. So these fixtures are literal: they are what a run gives
 * the worker, and the worker's job is to stage exactly that.
 */
const MANIFESTS: ServiceBackupManifest[] = [
  { service: 'nginx', dataSubdir: 'nginx-proxy-manager', include: ['data/database.sqlite'], exclude: [], collector: { kind: 'npm-sqlite' } },
  { service: 'adguard', include: ['conf/AdGuardHome.yaml'], exclude: [] },
  { service: 'authelia', dataSubdir: 'auth/authelia-data', gateOn: 'auth', include: ['db.sqlite3'], exclude: [] },
  { service: 'syncthing', gateOn: 'file-share', volume: 'file-share-syncthing-config', include: ['config.xml'], exclude: [] },
];
const manifestFor = (service: string): ServiceBackupManifest =>
  MANIFESTS.find(m => m.service === service)!;
const MANIFESTS_JSON = JSON.stringify(MANIFESTS);
import type { WorkerStatus } from '../contract/status';

describe('parseWorkerArgs', () => {
  it('parses the one-shot args', () => {
    const opts = parseWorkerArgs(['--stacks', '/mnt/stacks', '--out', '/out', '--services', 'a,b,c', '--manifests', MANIFESTS_JSON, '--run-id', 'r1']);
    expect(opts).toMatchObject({ stacks: '/mnt/stacks', out: '/out', services: ['a', 'b', 'c'], runId: 'r1' });
    expect('manifests' in opts && opts.manifests.map(m => m.service)).toEqual(MANIFESTS.map(m => m.service));
  });

  it('parses the optional --volumes root (#2596)', () => {
    const opts = parseWorkerArgs(['--stacks', '/s', '--out', '/o', '--services', 'a', '--manifests', MANIFESTS_JSON, '--volumes', '/mnt/volumes']);
    expect(opts).toMatchObject({ volumes: '/mnt/volumes' });
    // …and stays undefined when the run needs no named volume.
    expect(parseWorkerArgs(['--stacks', '/s', '--out', '/o', '--services', 'a', '--manifests', MANIFESTS_JSON])).toMatchObject({ volumes: undefined });
  });

  it('trims + drops empty service tokens', () => {
    const opts = parseWorkerArgs(['--stacks', '/s', '--out', '/o', '--services', 'a, ,b,', '--manifests', MANIFESTS_JSON]);
    expect('services' in opts && opts.services).toEqual(['a', 'b']);
  });

  it('requires --stacks, --out, --services', () => {
    const m = ['--manifests', MANIFESTS_JSON];
    expect(() => parseWorkerArgs(['--out', '/o', '--services', 'a', ...m])).toThrow(WorkerArgError);
    expect(() => parseWorkerArgs(['--stacks', '/s', '--services', 'a', ...m])).toThrow(WorkerArgError);
    expect(() => parseWorkerArgs(['--stacks', '/s', '--out', '/o', ...m])).toThrow(WorkerArgError);
  });

  it('requires the resolved manifests — a run without them would back up NOTHING and exit 0 (#2858)', () => {
    const base = ['--stacks', '/s', '--out', '/o', '--services', 'a'];
    delete process.env.BACKUP_MANIFESTS;
    expect(() => parseWorkerArgs(base)).toThrow(/--manifests/);
    expect(() => parseWorkerArgs([...base, '--manifests', '[{"service":"a"}]'])).toThrow(/include/);
    expect(() => parseWorkerArgs([...base, '--manifests', 'not json'])).toThrow(/valid JSON/);
  });

  it('falls back to the BACKUP_MANIFESTS env var the launcher sets', () => {
    process.env.BACKUP_MANIFESTS = MANIFESTS_JSON;
    try {
      const opts = parseWorkerArgs(['--stacks', '/s', '--out', '/o', '--services', 'adguard']);
      expect('manifests' in opts && opts.manifests).toHaveLength(MANIFESTS.length);
    } finally {
      delete process.env.BACKUP_MANIFESTS;
    }
  });

  it('returns help for --help', () => {
    expect(parseWorkerArgs(['--help'])).toEqual({ help: true });
  });

  it('rejects an unknown argument', () => {
    expect(() => parseWorkerArgs(['--bogus'])).toThrow(WorkerArgError);
  });
});

describe('resolveServiceDataDir', () => {
  it('honours the manifest dataSubdir', () => {
    expect(resolveServiceDataDir('/mnt/stacks', manifestFor('nginx'))).toBe('/mnt/stacks/nginx-proxy-manager');
    expect(resolveServiceDataDir('/mnt/stacks', manifestFor('adguard'))).toBe('/mnt/stacks/adguard');
  });

  it('reads a volume-held manifest from the mounted named volume, not the stacks root (#2596)', () => {
    const syncthing = manifestFor('syncthing');
    expect(syncthing.volume).toBe('file-share-syncthing-config');
    expect(resolveServiceDataDir('/mnt/stacks', syncthing, '/mnt/volumes'))
      .toBe('/mnt/volumes/file-share-syncthing-config');
  });

  it('THROWS for a volume-held manifest with no --volumes root instead of silently using the stacks path', () => {
    // The fail-open shape this whole issue is about: a stacks fallback would
    // resolve to a directory that does not exist, stage nothing, and report the
    // service as "no config on disk yet" — a backup that quietly does nothing.
    expect(() => resolveServiceDataDir('/mnt/stacks', manifestFor('syncthing')))
      .toThrow(/no --volumes root/);
  });
});

describe('applyCollectorRemap', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bw-remap-')); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

  it('remaps to the sqlite snapshot when present', async () => {
    await fs.mkdir(path.join(tmp, 'data'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'data/database.sqlite.sb-backup'), 'snap');
    const remapped = await applyCollectorRemap(tmp, manifestFor('nginx'));
    expect(remapped.include).toContain('data/database.sqlite.sb-backup');
    expect(remapped.renames).toEqual({ 'data/database.sqlite.sb-backup': 'data/database.sqlite' });
  });

  it('leaves the manifest unchanged when no snapshot exists', async () => {
    const m = manifestFor('nginx');
    expect(await applyCollectorRemap(tmp, m)).toBe(m);
  });

  it('is a no-op for a non-collector manifest', async () => {
    const m = manifestFor('adguard');
    expect(await applyCollectorRemap(tmp, m)).toBe(m);
  });

  describe('pg-dump (#2864)', () => {
    const pgManifest: ServiceBackupManifest = {
      service: 'paperless',
      include: ['media', 'pgdata'],
      exclude: [],
      collector: { kind: 'pg-dump', container: 'paperless-db', user: 'paperless', database: 'paperless' },
    };

    it('stages the dump under its canonical name and drops the cluster dir', async () => {
      await fs.writeFile(path.join(tmp, 'paperless.dump.sb-dump'), 'PGDUMP-CUSTOM');
      const remapped = await applyCollectorRemap(tmp, pgManifest);
      expect(remapped.include).toContain('paperless.dump.sb-dump');
      expect(remapped.renames).toEqual({ 'paperless.dump.sb-dump': 'paperless.dump' });
      // Excluded by the COLLECTOR, though the manifest declared it an include.
      expect(remapped.exclude).toContain('pgdata');
    });

    it('THROWS when the host-side pg_dump left no dump — the run reports the service as failed', async () => {
      // There is nothing to degrade to (the raw cluster dir is never staged), so
      // a missing dump must be loud. A silent pass would ship a paperless tarball
      // with media and no database in it.
      await expect(applyCollectorRemap(tmp, pgManifest)).rejects.toThrow(/produced no dump/);
    });

    it('THROWS on an empty dump rather than shipping a 0-byte file', async () => {
      await fs.writeFile(path.join(tmp, 'paperless.dump.sb-dump'), '');
      await expect(applyCollectorRemap(tmp, pgManifest)).rejects.toThrow(/EMPTY dump/);
    });
  });
});

describe('runWorker', () => {
  function fakeIO(overrides: Partial<WorkerIO> = {}): { io: WorkerIO; statuses: WorkerStatus[] } {
    const statuses: WorkerStatus[] = [];
    const io: WorkerIO = {
      buildTar: vi.fn(async () => ({ files: 2, bytes: 100 })),
      writeStatus: (_out, status) => { statuses.push(structuredClone(status)); },
      ...overrides,
    };
    return { io, statuses };
  }
  const opts = { stacks: '/mnt/stacks', out: '/out', services: ['adguard', 'authelia'], manifests: MANIFESTS, runId: 'r' };

  it('tars each service and finishes done', async () => {
    const { io, statuses } = fakeIO();
    const final = await runWorker(opts, io);
    expect(final.phase).toBe('done');
    expect(final.results.map(r => r.service)).toEqual(['adguard', 'authelia']);
    expect(final.results.every(r => r.ok && r.outcome === 'ok')).toBe(true);
    expect(io.buildTar).toHaveBeenCalledTimes(2);
    // status was ticked along the way (never empty)
    expect(statuses.length).toBeGreaterThan(2);
  });

  it('records a "No config files" failure as a skip without aborting the run', async () => {
    const { io } = fakeIO({
      buildTar: vi.fn(async (_d: string, m: ServiceBackupManifest) => {
        if (m.service === 'adguard') throw new Error('No config files to back up for "adguard"');
        return { files: 1, bytes: 50 };
      }),
    });
    const final = await runWorker(opts, io);
    expect(final.phase).toBe('done');
    expect(final.results.find(r => r.service === 'adguard')).toMatchObject({ ok: false, outcome: 'skip' });
    expect(final.results.find(r => r.service === 'authelia')).toMatchObject({ ok: true });
  });

  it('records a real error outcome but still completes the run', async () => {
    const { io } = fakeIO({
      buildTar: vi.fn(async (_d: string, m: ServiceBackupManifest) => {
        if (m.service === 'adguard') throw new Error('disk exploded');
        return { files: 1, bytes: 50 };
      }),
    });
    const final = await runWorker(opts, io);
    expect(final.phase).toBe('done');
    expect(final.results.find(r => r.service === 'adguard')).toMatchObject({ ok: false, outcome: 'error', detail: 'disk exploded' });
  });

  it('stages a volume-held service from the --volumes root (#2596)', async () => {
    const seen: string[] = [];
    const { io } = fakeIO({
      buildTar: vi.fn(async (dir: string) => { seen.push(dir); return { files: 1, bytes: 10 }; }),
    });
    const final = await runWorker(
      { ...opts, services: ['syncthing'], volumes: '/mnt/volumes' },
      io,
    );
    expect(seen).toEqual(['/mnt/volumes/file-share-syncthing-config']);
    expect(final.results[0]).toMatchObject({ service: 'syncthing', ok: true, outcome: 'ok' });
  });

  it('reports a volume-held service launched WITHOUT --volumes as a visible error, not a skip', async () => {
    const { io } = fakeIO();
    const final = await runWorker({ ...opts, services: ['syncthing', 'adguard'] }, io);
    expect(final.phase).toBe('done'); // one bad service still doesn't abort the run
    expect(final.results[0]).toMatchObject({ service: 'syncthing', ok: false, outcome: 'error' });
    expect(final.results[0].detail).toMatch(/no --volumes root/);
    expect(final.results[1]).toMatchObject({ service: 'adguard', ok: true });
  });

  it('carries an ok service\'s UNREADABLE files through to the status (#2877)', async () => {
    // The tar landed, so the row is `ok` — but it is missing a declared file, and
    // an ok row that hides that is how a backup without its database looks green.
    const { io } = fakeIO({
      buildTar: vi.fn(async (_d: string, m: ServiceBackupManifest) =>
        m.service === 'adguard'
          ? { files: 1, bytes: 50, skipped: ['data/database.sqlite'] }
          : { files: 2, bytes: 100 }),
    });
    const final = await runWorker(opts, io);
    const adguard = final.results.find(r => r.service === 'adguard')!;
    expect(adguard).toMatchObject({ ok: true, outcome: 'ok', skipped: ['data/database.sqlite'] });
    expect(adguard.detail).toMatch(/unreadable and not in the tar: data\/database\.sqlite/);
    // A complete service carries no `skipped` field at all.
    expect(final.results.find(r => r.service === 'authelia')).toMatchObject({ ok: true, detail: null });
    expect(final.results.find(r => r.service === 'authelia')?.skipped).toBeUndefined();
  });

  it('marks an unknown service as an error', async () => {
    const { io } = fakeIO();
    const final = await runWorker({ ...opts, services: ['nope'] }, io);
    expect(final.results[0]).toMatchObject({ service: 'nope', ok: false, outcome: 'error' });
    expect(io.buildTar).not.toHaveBeenCalled();
  });
});
