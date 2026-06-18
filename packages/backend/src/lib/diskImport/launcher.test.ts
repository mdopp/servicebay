import { describe, it, expect, vi } from 'vitest';

// The launcher resolves Immich-provisioning env (admin key + box users) before
// `podman run` (#1954). That touches the secret store + LLDAP; stub it so these
// launcher unit tests stay hermetic. Per-test overrides via vi.mocked below.
vi.mock('./immichProvisionEnv', () => ({
  resolveImmichProvisionEnv: vi.fn(async () => [] as string[]),
}));

import { launchWorker, readStatus, isWorkerRunning, stopWorker, WORKER_IMAGE, WORKER_MEMORY } from './launcher';
import { resolveImmichProvisionEnv } from './immichProvisionEnv';
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
    const mountpoint = mountCall![4];

    // the RO mountpoint dir is created (sudo) BEFORE the mount — else
    // "mount point does not exist" and the worker never launches (#1963).
    const mkdirIdx = calls.findIndex(c => c[0] === 'mkdir' && c[1] === '-p' && c[2] === mountpoint);
    const mountIdx = calls.findIndex(c => c[0] === 'mount');
    expect(mkdirIdx).toBeGreaterThanOrEqual(0);
    expect(mkdirIdx).toBeLessThan(mountIdx);

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

  it('injects the resolved Immich provisioning env into the container (#1954)', async () => {
    vi.mocked(resolveImmichProvisionEnv).mockResolvedValueOnce([
      '-e', 'IMMICH_SERVER_URL=http://127.0.0.1:2283',
      '-e', 'IMMICH_ADMIN_API_KEY=secret',
      '-e', 'DISK_IMPORT_BOX_USERS=[]',
    ]);
    const { exec, calls } = recExec();
    await launchWorker({ exec, device: '/dev/sda1', runId: 'k', dataDir: '/data', shareGid: 1024 });
    const podmanRun = calls.find(c => c[0] === 'podman' && c[1] === 'run')!;
    expect(podmanRun).toContain('IMMICH_ADMIN_API_KEY=secret');
    expect(podmanRun).toContain('IMMICH_SERVER_URL=http://127.0.0.1:2283');
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
