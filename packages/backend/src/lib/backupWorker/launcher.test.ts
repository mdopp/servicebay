import { beforeEach, describe, it, expect, vi } from 'vitest';

const readFileMock = vi.fn();
vi.mock('node:fs/promises', () => {
  const readFile = (...args: unknown[]) => readFileMock(...args);
  return { readFile, default: { readFile } };
});

import { DATA_DIR } from '@/lib/dirs';

import {
  launchBackupWorker,
  readBackupStatus,
  isBackupWorkerRunning,
  stopBackupWorker,
  readBackupTar,
  BACKUP_WORKER_IMAGE,
  BACKUP_WORKER_MEMORY,
  type SafeExec,
} from './launcher';

/** A SafeExec recording its calls, with per-argv canned stdout. */
function recExec(responses: Record<string, { stdout?: string; code?: number }> = {}) {
  const calls: string[][] = [];
  const exec: SafeExec = vi.fn(async (argv: string[]) => {
    calls.push(argv);
    const key = argv.join(' ');
    const match = Object.entries(responses).find(([k]) => key.includes(k));
    return { stdout: match?.[1].stdout ?? '', stderr: '', code: match?.[1].code ?? 0 };
  });
  return { exec, calls };
}

describe('launchBackupWorker', () => {
  it('creates the out dir then runs the worker container, memory-capped, stacks RO', async () => {
    const { exec, calls } = recExec();
    const run = await launchBackupWorker({
      exec, services: ['adguard', 'nginx'], runId: 'abc', dataDir: '/data', stacksDir: '/mnt/data/stacks',
    });

    expect(run.container).toBe('backup-worker-abc');
    expect(run.outDir).toBe('/data/backup-runs/abc');

    // outDir is created BEFORE `podman run -v <outDir>:/out` (else statfs error).
    const mkdirIdx = calls.findIndex(c => c[0] === 'mkdir' && c[2] === '/data/backup-runs/abc');
    const runIdx = calls.findIndex(c => c[0] === 'podman' && c[1] === 'run');
    expect(mkdirIdx).toBeGreaterThanOrEqual(0);
    expect(mkdirIdx).toBeLessThan(runIdx);

    const podmanRun = calls[runIdx];
    expect(podmanRun).toContain('-d');
    expect(podmanRun).toContain('--rm');
    expect(podmanRun).toContain(`--memory=${BACKUP_WORKER_MEMORY}`);
    expect(podmanRun).toContain(BACKUP_WORKER_IMAGE);
    // stacks mounted read-only
    expect(podmanRun.some(a => a === '/mnt/data/stacks:/mnt/stacks:ro')).toBe(true);
    // services passed through
    const sIdx = podmanRun.indexOf('--services');
    expect(podmanRun[sIdx + 1]).toBe('adguard,nginx');
  });

  it('fails fast with a resolveHostDataDir hint when the out mkdir errors (EROFS)', async () => {
    const { exec } = recExec({ 'mkdir -p': { code: 1, stdout: 'Read-only file system' } });
    await expect(
      launchBackupWorker({ exec, services: ['adguard'], runId: 'x', dataDir: '/app/data', stacksDir: '/s' }),
    ).rejects.toThrow(/resolveHostDataDir/);
  });

  it('refuses an empty service list', async () => {
    const { exec } = recExec();
    await expect(
      launchBackupWorker({ exec, services: [], runId: 'x', dataDir: '/d', stacksDir: '/s' }),
    ).rejects.toThrow(/no services/);
  });
});

describe('readBackupStatus', () => {
  const run = { runId: 'r', outDir: '/out/r', container: 'backup-worker-r' };

  it('parses the compact status.json', async () => {
    const { exec } = recExec({ 'cat /out/r/status.json': { stdout: JSON.stringify({ phase: 'done', processed: 3 }) } });
    expect(await readBackupStatus(exec, run)).toMatchObject({ phase: 'done', processed: 3 });
  });

  it('returns null before the worker has written anything', async () => {
    const { exec } = recExec({ cat: { stdout: '', code: 1 } });
    expect(await readBackupStatus(exec, run)).toBeNull();
  });
});

describe('isBackupWorkerRunning', () => {
  const run = { runId: 'r', outDir: '/o', container: 'backup-worker-r' };
  it('is true when podman ps lists the container', async () => {
    const { exec } = recExec({ 'podman ps': { stdout: 'backup-worker-r\n' } });
    expect(await isBackupWorkerRunning(exec, run)).toBe(true);
  });
  it('is false when the container is gone', async () => {
    const { exec } = recExec({ 'podman ps': { stdout: '' } });
    expect(await isBackupWorkerRunning(exec, run)).toBe(false);
  });
});

describe('stopBackupWorker', () => {
  it('force-removes the container', async () => {
    const { exec, calls } = recExec();
    await stopBackupWorker(exec, { runId: 'r', outDir: '/o', container: 'backup-worker-r' });
    expect(calls).toContainEqual(['podman', 'rm', '-f', 'backup-worker-r']);
  });
});

describe('readBackupTar', () => {
  // run.outDir is the HOST path; servicebay reads the SAME bytes off its own
  // in-container data mount (DATA_DIR). The read goes through fs.readFile
  // directly — never the agent seam / `base64` exec (#1973).
  const run = { runId: 'r', outDir: '/mnt/data/servicebay/backup-runs/r', container: 'backup-worker-r' };
  const inContainerTar = (name: string) => `${DATA_DIR}/backup-runs/r/${name}`;

  beforeEach(() => {
    readFileMock.mockReset();
  });

  it('reads the tar directly off the in-container out dir, never via the agent', async () => {
    const tar = Buffer.from('hello tar');
    readFileMock.mockImplementation(async (p: string) =>
      p === inContainerTar('adguard.tar') ? tar : Promise.reject(new Error(`ENOENT: ${p}`)),
    );
    const { exec, calls } = recExec();

    const got = await readBackupTar(exec, run, 'adguard.tar');

    expect(got.equals(tar)).toBe(true);
    expect(readFileMock).toHaveBeenCalledWith(inContainerTar('adguard.tar'));
    // The agent exec seam (and therefore `base64`) is NOT used for the read.
    expect(calls).toHaveLength(0);
  });

  it('translates the HOST outDir to the in-container path (not run.outDir)', async () => {
    readFileMock.mockResolvedValue(Buffer.from('x'));
    const { exec } = recExec();
    await readBackupTar(exec, run, 'npm.tar');
    expect(readFileMock).toHaveBeenCalledWith(inContainerTar('npm.tar'));
    expect(readFileMock).not.toHaveBeenCalledWith(`${run.outDir}/npm.tar`);
  });

  it('throws a path-tagged error on a read failure', async () => {
    readFileMock.mockRejectedValue(new Error('ENOENT: no such file'));
    const { exec } = recExec();
    await expect(readBackupTar(exec, run, 'x.tar')).rejects.toThrow(
      new RegExp(`failed to read x\\.tar from ${inContainerTar('x.tar').replace(/[/.]/g, '\\$&')}`),
    );
  });
});
