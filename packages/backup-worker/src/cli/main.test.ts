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
import { getServiceManifest, type ServiceBackupManifest } from '../engine/serviceManifest';
import type { WorkerStatus } from '../contract/status';

describe('parseWorkerArgs', () => {
  it('parses the one-shot args', () => {
    const opts = parseWorkerArgs(['--stacks', '/mnt/stacks', '--out', '/out', '--services', 'a,b,c', '--run-id', 'r1']);
    expect(opts).toMatchObject({ stacks: '/mnt/stacks', out: '/out', services: ['a', 'b', 'c'], runId: 'r1' });
  });

  it('parses the optional --volumes root (#2596)', () => {
    const opts = parseWorkerArgs(['--stacks', '/s', '--out', '/o', '--services', 'a', '--volumes', '/mnt/volumes']);
    expect(opts).toMatchObject({ volumes: '/mnt/volumes' });
    // …and stays undefined when the run needs no named volume.
    expect(parseWorkerArgs(['--stacks', '/s', '--out', '/o', '--services', 'a'])).toMatchObject({ volumes: undefined });
  });

  it('trims + drops empty service tokens', () => {
    const opts = parseWorkerArgs(['--stacks', '/s', '--out', '/o', '--services', 'a, ,b,']);
    expect('services' in opts && opts.services).toEqual(['a', 'b']);
  });

  it('requires --stacks, --out, --services', () => {
    expect(() => parseWorkerArgs(['--out', '/o', '--services', 'a'])).toThrow(WorkerArgError);
    expect(() => parseWorkerArgs(['--stacks', '/s', '--services', 'a'])).toThrow(WorkerArgError);
    expect(() => parseWorkerArgs(['--stacks', '/s', '--out', '/o'])).toThrow(WorkerArgError);
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
    expect(resolveServiceDataDir('/mnt/stacks', getServiceManifest('nginx')!)).toBe('/mnt/stacks/nginx-proxy-manager');
    expect(resolveServiceDataDir('/mnt/stacks', getServiceManifest('adguard')!)).toBe('/mnt/stacks/adguard');
  });

  it('reads a volume-held manifest from the mounted named volume, not the stacks root (#2596)', () => {
    const syncthing = getServiceManifest('syncthing')!;
    expect(syncthing.volume).toBe('file-share-syncthing-config');
    expect(resolveServiceDataDir('/mnt/stacks', syncthing, '/mnt/volumes'))
      .toBe('/mnt/volumes/file-share-syncthing-config');
  });

  it('THROWS for a volume-held manifest with no --volumes root instead of silently using the stacks path', () => {
    // The fail-open shape this whole issue is about: a stacks fallback would
    // resolve to a directory that does not exist, stage nothing, and report the
    // service as "no config on disk yet" — a backup that quietly does nothing.
    expect(() => resolveServiceDataDir('/mnt/stacks', getServiceManifest('syncthing')!))
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
    const remapped = await applyCollectorRemap(tmp, getServiceManifest('nginx')!);
    expect(remapped.include).toContain('data/database.sqlite.sb-backup');
    expect(remapped.renames).toEqual({ 'data/database.sqlite.sb-backup': 'data/database.sqlite' });
  });

  it('leaves the manifest unchanged when no snapshot exists', async () => {
    const m = getServiceManifest('nginx')!;
    expect(await applyCollectorRemap(tmp, m)).toBe(m);
  });

  it('is a no-op for a non-collector manifest', async () => {
    const m = getServiceManifest('adguard')!;
    expect(await applyCollectorRemap(tmp, m)).toBe(m);
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
  const opts = { stacks: '/mnt/stacks', out: '/out', services: ['adguard', 'authelia'], runId: 'r' };

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

  it('marks an unknown service as an error', async () => {
    const { io } = fakeIO();
    const final = await runWorker({ ...opts, services: ['nope'] }, io);
    expect(final.results[0]).toMatchObject({ service: 'nope', ok: false, outcome: 'error' });
    expect(io.buildTar).not.toHaveBeenCalled();
  });
});
