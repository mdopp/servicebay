// Disk-import — worker-container launcher (#1953/#1954, slice of #1949).
//
// THIS REPLACES THE IN-PROCESS HEAVY PATH. Previously servicebay ran the whole
// walk/hash/classify/dedup/plan/apply inside its own Node process (service.ts),
// which OOM'd the control plane on a 269k-file disk (feedback control-plane vs
// worker). Now the heavy job runs in a resource-capped worker CONTAINER:
// servicebay only launches it and reads the compact status.json it writes.
//
//   servicebay ──"Scan disk"──▶ podman run --rm --memory=1g <worker-image> --serve
//      reads status.json (compact)        (device ro at /mnt/src, out volume /out)
//
// The control plane never pulls the heavy plan/inventory into its own memory — an
// OOM/kill of the worker kills the JOB, not servicebay/UI/HA. Liveness is
// `podman ps`, not in-memory session bookkeeping.
//
// Imported files stay CORE-owned: the worker's apply chowns copies to the
// file-share gid, never to a per-user uid (feedback_fileshare_relabel_crashloop)
// — servicebay does no chowning here.

import type { SafeExec } from '@servicebay/disk-import-worker';
import { STATUS_FILE, type WorkerStatus } from '@servicebay/disk-import-worker';
import { assertSafeDevice, mountpointFor } from '@servicebay/disk-import-worker';

/** The published worker image — built + pushed by .github/workflows/build-images.yml. */
export const WORKER_IMAGE = 'ghcr.io/mdopp/servicebay-disk-import-worker:latest';

/** Hard memory cap for the worker container — a big input OOMs it, not the box. */
export const WORKER_MEMORY = '1g';

/** Port the worker app server listens on inside the container (Containerfile EXPOSE). */
export const WORKER_PORT = 8080;

/** A launched worker run servicebay tracks by container name + out dir. */
export interface WorkerRun {
  /** Opaque run id (also the container name suffix + out-dir name). */
  runId: string;
  /** Host dir bind-mounted to the container's /out — where status.json lands. */
  outDir: string;
  /** The container name (`disk-import-worker-<runId>`). */
  container: string;
}

/** A removable partition the tile offers as an import source. */
export interface ImportDevice {
  path: string;
  display: string;
}

/** Base dir under DATA for per-run worker out volumes (status.json + plan). */
export function workerOutBase(dataDir: string): string {
  return `${dataDir}/disk-import-runs`;
}

function containerName(runId: string): string {
  return `disk-import-worker-${runId}`;
}

/**
 * Launch the worker container in --serve mode over the device, read-only. Mounts
 * the device RO host-side first, then runs `podman run -d --rm --memory=…` with
 * the mount and a fresh per-run out dir. Returns the run handle; the worker app
 * is then reachable on WORKER_PORT (servicebay provisions the proxy in #1954).
 *
 * The container is detached (`-d`); its lifetime is its own — an OOM kills only
 * the container. servicebay reads progress from {@link readStatus}.
 */
export async function launchWorker(args: {
  exec: SafeExec;
  device: string;
  runId: string;
  dataDir: string;
  shareGid: number;
}): Promise<WorkerRun> {
  const { exec, device, runId, dataDir, shareGid } = args;
  assertSafeDevice(device);
  const mountpoint = mountpointFor(device);
  const outDir = `${workerOutBase(dataDir)}/${runId}`;
  const container = containerName(runId);

  await exec(['mkdir', '-p', outDir]);
  await exec(['mount', '-o', 'ro', device, mountpoint], { sudo: true });

  await exec([
    'podman', 'run', '-d', '--rm',
    '--name', container,
    `--memory=${WORKER_MEMORY}`,
    `--memory-swap=${WORKER_MEMORY}`,
    '-p', `${WORKER_PORT}`,
    '-v', `${mountpoint}:/mnt/src:ro`,
    '-v', `${outDir}:/out`,
    '-e', `DISK_IMPORT_RUN_ID=${runId}`,
    '-e', `DISK_IMPORT_SHARE_GID=${shareGid}`,
    WORKER_IMAGE,
    '--serve', '--share-gid', String(shareGid),
  ]);

  return { runId, outDir, container };
}

/**
 * Read the COMPACT status.json the worker writes — the ONLY heavy-job state the
 * control plane ever loads (never the 269k-node plan). Returns null before the
 * worker has written anything (or if the file is unreadable mid-write).
 */
export async function readStatus(exec: SafeExec, run: WorkerRun): Promise<WorkerStatus | null> {
  try {
    const { stdout, code } = await exec(['cat', `${run.outDir}/${STATUS_FILE}`]);
    if (code !== 0 || !stdout.trim()) return null;
    return JSON.parse(stdout) as WorkerStatus;
  } catch {
    return null;
  }
}

/** Liveness via `podman ps` — no in-memory session bookkeeping (#1949). */
export async function isWorkerRunning(exec: SafeExec, run: WorkerRun): Promise<boolean> {
  const { stdout } = await exec(['podman', 'ps', '--filter', `name=${run.container}`, '--format', '{{.Names}}']);
  return stdout.split('\n').some(line => line.trim() === run.container);
}

/** Stop a worker container (the tile's "Start over" / abort). Best-effort. */
export async function stopWorker(exec: SafeExec, run: WorkerRun): Promise<void> {
  await exec(['podman', 'rm', '-f', run.container]).catch(() => {});
}

/** Ensure the worker image is present on the node (pull if missing). */
export async function ensureWorkerImage(exec: SafeExec): Promise<void> {
  const { stdout } = await exec(['podman', 'image', 'exists', WORKER_IMAGE]).catch(() => ({ stdout: '', stderr: '', code: 1 }));
  void stdout;
  await exec(['podman', 'pull', WORKER_IMAGE]);
}
