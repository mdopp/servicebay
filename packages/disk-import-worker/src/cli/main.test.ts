import { describe, it, expect, vi } from 'vitest';

import {
  parseWorkerArgs,
  runWorker,
  WorkerArgError,
  type WorkerIO,
  type WorkerOptions,
} from './main';
import type { ScannedFile } from '../engine/inventory';
import type { WorkerStatus, PlanSidecar } from '../contract/status';

function makeIO(overrides: Partial<WorkerIO> = {}): {
  io: WorkerIO;
  statuses: WorkerStatus[];
  sidecars: PlanSidecar[];
} {
  const statuses: WorkerStatus[] = [];
  const sidecars: PlanSidecar[] = [];
  const io: WorkerIO = {
    scan: async () =>
      [
        { path: '/mnt/src/a.jpg', size: 100, mtimeMs: 1 },
        { path: '/mnt/src/b.mp3', size: 50, mtimeMs: 2 },
        { path: '/mnt/src/thumbs.db', size: 1, mtimeMs: 3 },
      ] satisfies ScannedFile[],
    hashOf: r => `hash-${r.sourcePath}`,
    writeStatus: (_out, status) => statuses.push({ ...status }),
    writePlanSidecar: (_out, sidecar) => sidecars.push(sidecar),
    makeExec: () => {
      throw new Error('makeExec must NOT be called on a dry run');
    },
    provisionImmich: async () => '',
    ...overrides,
  };
  return { io, statuses, sidecars };
}

const dryOpts: WorkerOptions = {
  mount: '/mnt/src',
  out: '/out',
  mode: 'dry-run',
  catalog: ':memory:',
  runId: 'run-x',
  shareGid: 1024,
};

describe('parseWorkerArgs', () => {
  it('defaults to dry-run and in-memory catalog', () => {
    const opts = parseWorkerArgs(['--mount', '/m', '--out', '/o', '--run-id', 'r']);
    expect(opts).toMatchObject({ mount: '/m', out: '/o', mode: 'dry-run', catalog: ':memory:', runId: 'r' });
  });

  it('--apply switches mode and defaults the catalog into the out volume', () => {
    const opts = parseWorkerArgs(['--mount', '/m', '--out', '/o', '--apply']) as WorkerOptions;
    expect(opts.mode).toBe('apply');
    expect(opts.catalog).toBe('/o/catalog.sqlite');
  });

  it('requires --mount and --out', () => {
    expect(() => parseWorkerArgs(['--out', '/o'])).toThrow(WorkerArgError);
    expect(() => parseWorkerArgs(['--mount', '/m'])).toThrow(WorkerArgError);
  });

  it('rejects a bad --share-gid and unknown args', () => {
    expect(() => parseWorkerArgs(['--mount', '/m', '--out', '/o', '--share-gid', 'x'])).toThrow(WorkerArgError);
    expect(() => parseWorkerArgs(['--mount', '/m', '--out', '/o', '--bogus'])).toThrow(WorkerArgError);
  });

  it('--help short-circuits', () => {
    expect(parseWorkerArgs(['--help'])).toEqual({ help: true });
  });
});

describe('runWorker (dry-run)', () => {
  it('writes a compact status progression and a heavy plan sidecar, touching no host', async () => {
    const { io, statuses, sidecars } = makeIO();
    const final = await runWorker(dryOpts, io);

    // Terminal state is done; never reached applying; makeExec never called.
    expect(final.phase).toBe('done');
    expect(statuses.map(s => s.phase)).toEqual(['scanning', 'planning', 'planning', 'done']);
    expect(final.scanned).toBe(3);
    expect(final.planned).toBeGreaterThan(0);
    expect(final.planSidecar).toBe('plan.json');

    // The compact status carries NO per-file arrays — only the rollup.
    for (const s of statuses) {
      expect(JSON.stringify(s)).not.toContain('/mnt/src/a.jpg');
    }
    // The heavy plan IS in the sidecar, written exactly once.
    expect(sidecars).toHaveLength(1);
    expect(sidecars[0].plan.items.length).toBe(final.planned);
    expect(sidecars[0].runId).toBe('run-x');
  });

  it('captures a failure into an error-phase status and rethrows', async () => {
    const { io, statuses } = makeIO({
      scan: async () => {
        throw new Error('device read failed');
      },
    });
    await expect(runWorker(dryOpts, io)).rejects.toThrow('device read failed');
    const last = statuses.at(-1)!;
    expect(last.phase).toBe('error');
    expect(last.error).toBe('device read failed');
  });
});

describe('runWorker (apply)', () => {
  it('builds the exec only after planning and chowns to the share gid (core-owned, not per-user)', async () => {
    const applyCalls: string[][] = [];
    const exec = vi.fn(async (argv: string[]) => {
      applyCalls.push(argv);
      return { stdout: '', stderr: '', code: 0 };
    });
    const { io, statuses } = makeIO({ makeExec: () => exec });
    const opts: WorkerOptions = { ...dryOpts, mode: 'apply', catalog: ':memory:' };
    const final = await runWorker(opts, io);

    expect(final.phase).toBe('done');
    expect(statuses.map(s => s.phase)).toContain('applying');
    // Host-apply ran; chown targets the share gid (1024), never a per-user uid
    // (feedback_fileshare_relabel_crashloop).
    const chowns = applyCalls.filter(a => a.includes('chown'));
    for (const c of chowns) {
      expect(c.some(arg => arg.includes('1024'))).toBe(true);
    }
  });

  it('provisions/scans Immich for the photo owners after photos are written (#1954)', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const provisionImmich = vi.fn(async () => 'Immich External Libraries provisioned + scan triggered.');
    const { io, statuses } = makeIO({ makeExec: () => exec, provisionImmich });
    const final = await runWorker({ ...dryOpts, mode: 'apply' }, io);

    expect(final.phase).toBe('done');
    // a.jpg is a photo → its owner ('shared') is handed to the provision hook.
    expect(provisionImmich).toHaveBeenCalledTimes(1);
    expect(provisionImmich).toHaveBeenCalledWith(expect.arrayContaining(['shared']));
    // The provision note is folded into the terminal step text.
    expect(statuses.at(-1)!.step).toContain('Immich External Libraries provisioned');
  });

  it('skips the Immich hook when no photos were written', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
    const provisionImmich = vi.fn(async () => '');
    const { io } = makeIO({
      makeExec: () => exec,
      provisionImmich,
      // Only non-photo files → no photo owners.
      scan: async () => [{ path: '/mnt/src/b.mp3', size: 50, mtimeMs: 2 }] satisfies ScannedFile[],
    });
    await runWorker({ ...dryOpts, mode: 'apply' }, io);
    expect(provisionImmich).not.toHaveBeenCalled();
  });
});
