// External/config backup — worker-container launcher (#1955, slice of #1949).
//
// THIS REPLACES THE IN-PROCESS HEAVY PATH. Previously servicebay walked + copied
// each service's config file-by-file through the agent channel and held every tar
// in its own Node process (externalBackup/producer.ts), which OOM'd the control
// plane on a HACS HA config (~5.3 GB, #1894 — feedback_control_plane_vs_worker).
// Now the heavy walk/copy/tar runs in a resource-capped worker CONTAINER:
// servicebay only launches it, reads the compact status.json it writes, and
// streams the per-service tars it produced to the NAS one at a time. The out dir
// is also mounted into servicebay's own /app/data, so it reads the produced tars
// DIRECTLY off its filesystem rather than shelling them back through the agent
// (the agent doesn't allowlist `base64`, which broke the tar→NAS read, #1973).
//
//   servicebay ──"Back up config"──▶ podman run --rm --memory=2g <worker> --stacks …
//      reads status.json (compact)        (stacks ro at /mnt/stacks, out volume /out)
//      streams <service>.tar → NAS        (one tar at a time, bounded I/O)
//
// The control plane never holds all the tars at once — an OOM/kill of the worker
// kills the JOB, not servicebay/UI/HA. Liveness is `podman ps`, not in-memory
// bookkeeping. The worker mounts the stacks dir READ-ONLY and writes only into
// /out — it never writes back into a stack (feedback_fileshare_relabel_crashloop).

import { readFile } from 'node:fs/promises';

import type { WorkerStatus } from '@servicebay/backup-worker';
import { STATUS_FILE } from '@servicebay/backup-worker';

import { DATA_DIR } from '@/lib/dirs';

/** Result of one structured `safe_exec` argv invocation (the agent seam). */
export interface SafeExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** The host-exec seam the launcher runs `podman`/`mkdir`/`cat` through — the
 *  agent's structured `safe_exec` (no shell). Mirrors the disk-import worker's
 *  SafeExec shape; defined locally so backup-worker doesn't depend on the
 *  disk-import worker package. Tars are read DIRECTLY off the filesystem
 *  (readBackupTar), not through this seam (#1973). */
export type SafeExec = (argv: string[], options?: { timeoutMs?: number; sudo?: boolean }) => Promise<SafeExecResult>;

/** The published worker image — built + pushed by .github/workflows/build-images.yml. */
export const BACKUP_WORKER_IMAGE = 'ghcr.io/mdopp/servicebay-backup-worker:latest';

/** Hard memory cap for the worker container — a big config OOMs it, not the box.
 *  Larger than the disk-import worker's 1g: a service tar (NPM certs, HA custom
 *  components) can be a few hundred MB and tar buffers it. */
export const BACKUP_WORKER_MEMORY = '2g';

/** Where the host stacks dir is mounted (read-only) inside the worker. */
const STACKS_MOUNT = '/mnt/stacks';

/** A launched backup-worker run servicebay tracks by container name + out dir. */
export interface BackupWorkerRun {
  /** Opaque run id (also the container name suffix + out-dir name). */
  runId: string;
  /** Host dir bind-mounted to the container's /out — where status.json + tars land. */
  outDir: string;
  /** The container name (`backup-worker-<runId>`). */
  container: string;
}

function containerName(runId: string): string {
  return `backup-worker-${runId}`;
}

/**
 * Base dir for per-run worker out volumes. `dataDir` MUST be the HOST-side data
 * path (HOST_DATA_DIR), since the out dir is both `mkdir`'d and bind-mounted
 * host-side by `podman run` — the in-container /app/data is read-only on the host
 * (the disk-import worker's exit-125 lesson, #1963/#1965).
 */
export function backupWorkerOutBase(dataDir: string): string {
  return `${dataDir}/backup-runs`;
}

/**
 * Launch the backup worker over the stacks dir, read-only. Creates the per-run
 * out dir host-side first (fail-fast if it can't — that means HOST_DATA_DIR is
 * wrong / fell back to /app/data), then runs `podman run -d --rm --memory=…`. The
 * stacks dir is already host-readable, so it's bind-mounted directly (no `mkdir`
 * of a /run mountpoint like the disk-import device path needs). Returns the run
 * handle; the worker writes status.json + <service>.tar into outDir.
 */
export async function launchBackupWorker(args: {
  exec: SafeExec;
  services: string[];
  runId: string;
  /** HOST-side data dir (HOST_DATA_DIR) — where the out volume is created. */
  dataDir: string;
  /** HOST-side stacks root (e.g. /mnt/data/stacks) bind-mounted RO into the worker. */
  stacksDir: string;
}): Promise<BackupWorkerRun> {
  const { exec, services, runId, dataDir, stacksDir } = args;
  if (services.length === 0) throw new Error('backup-worker: no services to back up');
  const outDir = `${backupWorkerOutBase(dataDir)}/${runId}`;
  const container = containerName(runId);

  // outDir must exist before `podman run -v <outDir>:/out`. It lives on the HOST
  // (dataDir = HOST_DATA_DIR), not in the container's /app/data (read-only on the
  // host). Fail fast: a read-only-filesystem error here means HOST_DATA_DIR is
  // wrong — surface it rather than letting `podman run` fail with a confusing statfs.
  const mkdirOut = await exec(['mkdir', '-p', outDir]);
  if (mkdirOut.code !== 0) {
    throw new Error(
      `backup-worker: failed to create worker out dir ${outDir}: ${mkdirOut.stderr || mkdirOut.stdout}. ` +
      `dataDir should be the HOST-side data dir resolved by resolveHostDataDir() (#1966); a ` +
      `read-only-filesystem error here means it fell back to the container-internal /app/data.`,
    );
  }

  await exec([
    'podman', 'run', '-d', '--rm',
    '--name', container,
    `--memory=${BACKUP_WORKER_MEMORY}`,
    `--memory-swap=${BACKUP_WORKER_MEMORY}`,
    '-v', `${stacksDir}:${STACKS_MOUNT}:ro`,
    // `:z` relabels the out dir to a SHARED SELinux label so the worker
    // container can write it. Without it the dir keeps servicebay's private
    // MCS categories (container_file_t:s0:cNNN,cMMM) and the freshly-spawned
    // worker gets different categories → EACCES on /out/status.json even as
    // root. Shared (`:z`) not private (`:Z`) because servicebay also reads the
    // status + tars back from this dir. (#1955 box-verify, rootless podman.)
    '-v', `${outDir}:/out:z`,
    '-e', `BACKUP_RUN_ID=${runId}`,
    BACKUP_WORKER_IMAGE,
    '--stacks', STACKS_MOUNT,
    '--out', '/out',
    '--services', services.join(','),
    '--run-id', runId,
  ]);

  return { runId, outDir, container };
}

/**
 * Read the COMPACT status.json the worker writes — the ONLY heavy-job state the
 * control plane loads (never the tar bytes). Returns null before the worker has
 * written anything (or if the file is unreadable mid-write).
 */
export async function readBackupStatus(exec: SafeExec, run: BackupWorkerRun): Promise<WorkerStatus | null> {
  try {
    const { stdout, code } = await exec(['cat', `${run.outDir}/${STATUS_FILE}`]);
    if (code !== 0 || !stdout.trim()) return null;
    return JSON.parse(stdout) as WorkerStatus;
  } catch {
    return null;
  }
}

/** Liveness via `podman ps` — no in-memory bookkeeping (#1949). */
export async function isBackupWorkerRunning(exec: SafeExec, run: BackupWorkerRun): Promise<boolean> {
  const { stdout } = await exec(['podman', 'ps', '--filter', `name=${run.container}`, '--format', '{{.Names}}']);
  return stdout.split('\n').some(line => line.trim() === run.container);
}

/** Stop a worker container (best-effort). */
export async function stopBackupWorker(exec: SafeExec, run: BackupWorkerRun): Promise<void> {
  await exec(['podman', 'rm', '-f', run.container]).catch(() => {});
}

/** Ensure the worker image is present on the node (pull if missing). */
export async function ensureBackupWorkerImage(exec: SafeExec): Promise<void> {
  await exec(['podman', 'pull', BACKUP_WORKER_IMAGE]);
}

/**
 * The IN-CONTAINER path of a run's out dir. `run.outDir` is the HOST path
 * (`${HOST_DATA_DIR}/backup-runs/<runId>`) used to bind-mount the worker's /out;
 * servicebay sees the SAME bytes at its own data mount (`${DATA_DIR}/backup-runs/
 * <runId>`), so it can read the produced tars directly off its filesystem — no
 * shelling `base64` through the agent seam (which doesn't allowlist `base64`,
 * #1973). In dev/test HOST_DATA_DIR === DATA_DIR so this is identity.
 */
function inContainerOutDir(run: BackupWorkerRun): string {
  return `${backupWorkerOutBase(DATA_DIR)}/${run.runId}`;
}

/**
 * Read one produced tar's bytes from the out volume. The worker wrote it into the
 * shared out dir, which is also mounted into servicebay's own /app/data — so we
 * read it DIRECTLY off the filesystem (in-container path), never through the agent
 * `base64` exec (`base64` isn't on the agent allowlist → the tars never reached
 * the NAS, #1973). servicebay streams these to the NAS one at a time.
 */
export async function readBackupTar(_exec: SafeExec, run: BackupWorkerRun, tarName: string): Promise<Buffer> {
  const path = `${inContainerOutDir(run)}/${tarName}`;
  try {
    return await readFile(path);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`backup-worker: failed to read ${tarName} from ${path}: ${message}`);
  }
}
