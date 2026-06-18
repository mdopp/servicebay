import { describe, it, expect, vi } from 'vitest';

// The launcher resolves Immich-provisioning env (admin key + box users) before
// `podman run` (#1954). That touches the secret store + LLDAP; stub it so these
// launcher unit tests stay hermetic. Per-test overrides via vi.mocked below.
vi.mock('./immichProvisionEnv', () => ({
  resolveImmichProvisionEnv: vi.fn(async () => [] as string[]),
}));

// launchWorker resolves the HOST data dir itself (env → self-inspect → default).
// Pin it for these launcher tests; resolveHostDataDir has its own unit tests.
vi.mock('@/lib/hostDataDir', () => ({
  resolveHostDataDir: vi.fn(async () => '/data'),
}));

import { launchWorker, readStatus, isWorkerRunning, stopWorker, cleanupRunMount, WORKER_IMAGE, WORKER_MEMORY } from './launcher';
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
    const run = await launchWorker({ exec, device: '/dev/sda1', runId: 'abc123', shareGid: 1024 });

    expect(run.container).toBe('disk-import-worker-abc123');
    expect(run.outDir).toBe('/data/disk-import-runs/abc123');

    // device is mounted read-only, with sudo, and SELinux-labeled at mount time
    // so the container_t worker can read the source (a read-only mount can't be
    // relabeled via `:z` on the bind, so the label is set with `context=`).
    const mountCall = calls.find(c => c[0] === 'mount');
    expect(mountCall).toEqual([
      'mount',
      '-o',
      'ro,context="system_u:object_r:container_file_t:s0"',
      '/dev/sda1',
      expect.any(String),
    ]);
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

    // the run handle carries device + mountpoint so teardown can unmount (#1941)
    expect(run.device).toBe('/dev/sda1');
    expect(run.mountpoint).toBe(mountpoint);
  });

  // #1941 — repeated scans of the same device must never stack mounts. The
  // launcher sweeps every existing mount of the device/mountpoint BEFORE mounting.
  it('sweeps stale mounts of the device before mounting, so scans never stack (#1941)', async () => {
    const { exec, calls } = recExec();
    await launchWorker({ exec, device: '/dev/sda1', runId: 'abc123', shareGid: 1024 });

    const mountIdx = calls.findIndex(c => c[0] === 'mount');
    // umount -A on both the device and the mountpoint runs BEFORE the fresh mount
    const sweepDevIdx = calls.findIndex(c => c[0] === 'umount' && c[1] === '-A' && c[2] === '/dev/sda1');
    const sweepMpIdx = calls.findIndex(c => c[0] === 'umount' && c[1] === '-A' && c[2]?.startsWith('/run/servicebay/disk-import/'));
    expect(sweepDevIdx).toBeGreaterThanOrEqual(0);
    expect(sweepMpIdx).toBeGreaterThanOrEqual(0);
    expect(sweepDevIdx).toBeLessThan(mountIdx);
    expect(sweepMpIdx).toBeLessThan(mountIdx);
    // exactly one fresh `mount` call — never stacked
    expect(calls.filter(c => c[0] === 'mount')).toHaveLength(1);
  });

  it('launches cleanly even when the sweep umount fails (cold/clean device) (#1941)', async () => {
    // "not mounted" → non-zero umount exit must NOT abort the launch.
    const { exec, calls } = recExec({ 'umount -A': { code: 1 } });
    const run = await launchWorker({ exec, device: '/dev/sda1', runId: 'abc123', shareGid: 1024 });
    expect(run.container).toBe('disk-import-worker-abc123');
    expect(calls.some(c => c[0] === 'mount')).toBe(true);
  });

  it('injects the resolved Immich provisioning env into the container (#1954)', async () => {
    vi.mocked(resolveImmichProvisionEnv).mockResolvedValueOnce([
      '-e', 'IMMICH_SERVER_URL=http://127.0.0.1:2283',
      '-e', 'IMMICH_ADMIN_API_KEY=secret',
      '-e', 'DISK_IMPORT_BOX_USERS=[]',
    ]);
    const { exec, calls } = recExec();
    await launchWorker({ exec, device: '/dev/sda1', runId: 'k', shareGid: 1024 });
    const podmanRun = calls.find(c => c[0] === 'podman' && c[1] === 'run')!;
    expect(podmanRun).toContain('IMMICH_ADMIN_API_KEY=secret');
    expect(podmanRun).toContain('IMMICH_SERVER_URL=http://127.0.0.1:2283');
  });

  it('refuses an unsafe device path', async () => {
    const { exec } = recExec();
    await expect(
      launchWorker({ exec, device: '/dev/sda1; rm -rf /', runId: 'x', shareGid: 1024 }),
    ).rejects.toThrow();
  });
});

describe('readStatus', () => {
  const run = { runId: 'r', outDir: '/data/runs/r', container: 'disk-import-worker-r', device: '/dev/sda1', mountpoint: '/run/servicebay/disk-import/sda1' };

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
  const run = { runId: 'r', outDir: '/o', container: 'disk-import-worker-r', device: '/dev/sda1', mountpoint: '/run/servicebay/disk-import/sda1' };

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
  const run = { runId: 'r', outDir: '/o', container: 'disk-import-worker-r', device: '/dev/sda1', mountpoint: '/run/servicebay/disk-import/sda1' };

  it('force-removes the container', async () => {
    const { exec, calls } = recExec();
    await stopWorker(exec, run);
    expect(calls).toContainEqual(['podman', 'rm', '-f', 'disk-import-worker-r']);
  });

  // #1941 — teardown must unmount the source device so the one-shot worker
  // leaves no mount behind (a crashed worker's mount would otherwise leak).
  it('unmounts the source device + drops the mountpoint on teardown (#1941)', async () => {
    const { exec, calls } = recExec();
    await stopWorker(exec, run);
    expect(calls).toContainEqual(['umount', '-A', '/dev/sda1']);
    expect(calls).toContainEqual(['umount', '-A', '/run/servicebay/disk-import/sda1']);
    expect(calls).toContainEqual(['rmdir', '/run/servicebay/disk-import/sda1']);
  });

  it('unmounts even if podman rm fails — a crashed worker still cleans up (#1941)', async () => {
    const { exec, calls } = recExec({ 'podman rm': { code: 1 } });
    await stopWorker(exec, run);
    expect(calls).toContainEqual(['umount', '-A', '/dev/sda1']);
  });
});

describe('cleanupRunMount', () => {
  it('sweeps the run device mounts; no-ops when the handle has no device (#1941)', async () => {
    const { exec, calls } = recExec();
    await cleanupRunMount(exec, { runId: 'r', outDir: '/o', container: 'c', device: '/dev/sdb1', mountpoint: '/run/servicebay/disk-import/sdb1' });
    expect(calls).toContainEqual(['umount', '-A', '/dev/sdb1']);

    const { exec: exec2, calls: calls2 } = recExec();
    // legacy handle without device/mountpoint (e.g. persisted before #1941)
    await cleanupRunMount(exec2, { runId: 'r', outDir: '/o', container: 'c' } as never);
    expect(calls2).toHaveLength(0);
  });
});
