import { describe, it, expect, vi } from 'vitest';
import { launchWorker, readStatus, isWorkerRunning, stopWorker, WORKER_IMAGE, WORKER_MEMORY } from './launcher';
import type { SafeExec } from '@servicebay/disk-import-worker';

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

describe('launchWorker', () => {
  it('mounts the device RO and runs the worker container, memory-capped', async () => {
    const { exec, calls } = recExec();
    const run = await launchWorker({ exec, device: '/dev/sda1', runId: 'abc123', dataDir: '/data', shareGid: 1024 });

    expect(run.container).toBe('disk-import-worker-abc123');
    expect(run.outDir).toBe('/data/disk-import-runs/abc123');

    // device is mounted read-only, with sudo
    const mountCall = calls.find(c => c[0] === 'mount');
    expect(mountCall).toEqual(['mount', '-o', 'ro', '/dev/sda1', expect.any(String)]);

    // the container runs detached, --rm, memory-capped, with the worker image
    const podmanRun = calls.find(c => c[0] === 'podman' && c[1] === 'run')!;
    expect(podmanRun).toContain('-d');
    expect(podmanRun).toContain('--rm');
    expect(podmanRun).toContain(`--memory=${WORKER_MEMORY}`);
    expect(podmanRun).toContain(WORKER_IMAGE);
    expect(podmanRun).toContain('--serve');
    // source mounted read-only into the container
    expect(podmanRun.some(a => a.endsWith(':/mnt/src:ro'))).toBe(true);
  });

  it('refuses an unsafe device path', async () => {
    const { exec } = recExec();
    await expect(
      launchWorker({ exec, device: '/dev/sda1; rm -rf /', runId: 'x', dataDir: '/data', shareGid: 1024 }),
    ).rejects.toThrow();
  });
});

describe('readStatus', () => {
  const run = { runId: 'r', outDir: '/data/runs/r', container: 'disk-import-worker-r' };

  it('parses the compact status.json', async () => {
    const { exec } = recExec({ 'cat /data/runs/r/status.json': { stdout: JSON.stringify({ phase: 'done', planned: 5 }) } });
    expect(await readStatus(exec, run)).toMatchObject({ phase: 'done', planned: 5 });
  });

  it('returns null before the worker has written anything', async () => {
    const { exec } = recExec({ 'cat': { stdout: '', code: 1 } });
    expect(await readStatus(exec, run)).toBeNull();
  });
});

describe('isWorkerRunning', () => {
  const run = { runId: 'r', outDir: '/o', container: 'disk-import-worker-r' };

  it('is true when podman ps lists the container', async () => {
    const { exec } = recExec({ 'podman ps': { stdout: 'disk-import-worker-r\n' } });
    expect(await isWorkerRunning(exec, run)).toBe(true);
  });

  it('is false when the container is gone', async () => {
    const { exec } = recExec({ 'podman ps': { stdout: '' } });
    expect(await isWorkerRunning(exec, run)).toBe(false);
  });
});

describe('stopWorker', () => {
  it('force-removes the container', async () => {
    const { exec, calls } = recExec();
    await stopWorker(exec, { runId: 'r', outDir: '/o', container: 'disk-import-worker-r' });
    expect(calls).toContainEqual(['podman', 'rm', '-f', 'disk-import-worker-r']);
  });
});
