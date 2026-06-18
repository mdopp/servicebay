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

import { resolveHostDataDir } from '@/lib/hostDataDir';
import { resolveImmichProvisionEnv } from './immichProvisionEnv';

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
  /** The source device node (`/dev/sda1`) — so teardown can unmount it (#1941). */
  device: string;
  /** The host-side RO mountpoint of the device (under MOUNT_BASE) (#1941). */
  mountpoint: string;
}

/** A removable partition the tile offers as an import source. */
export interface ImportDevice {
  path: string;
  display: string;
}

/**
 * Base dir for per-run worker out volumes (status.json + plan). `hostDataDir` must
 * be the HOST-side data path (see {@link resolveHostDataDir}), since the out dir is
 * both `mkdir`'d and bind-mounted (`-v <outDir>:/out`) by host-side commands — the
 * in-container `/app/data` is read-only on the host.
 */
export function workerOutBase(hostDataDir: string): string {
  return `${hostDataDir}/disk-import-runs`;
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
  shareGid: number;
}): Promise<WorkerRun> {
  const { exec, device, runId, shareGid } = args;
  assertSafeDevice(device);
  const mountpoint = mountpointFor(device);
  // Resolve the HOST path of servicebay's data dir at launch time (env →
  // self-inspect via the mounted podman socket → conventional default). The out
  // dir is both `mkdir`'d and bind-mounted host-side, so it MUST be a host path,
  // never the in-container /app/data (read-only on the host).
  const hostDataDir = await resolveHostDataDir(exec);
  const outDir = `${workerOutBase(hostDataDir)}/${runId}`;
  const container = containerName(runId);

  // IDEMPOTENT MOUNT (#1941): a prior scan (incl. one that crashed before its
  // teardown unmount) can leave the device stacked-mounted at `mountpoint`.
  // `mount -o ro` does NOT check this and just stacks another layer; after a few
  // the kernel mount on the over-stacked device blocks and the next scan hangs at
  // "Starting…". So sweep EVERY existing mount of this device/mountpoint first,
  // then mount exactly once — repeated scans of the same disk leave one mount.
  await sweepDeviceMounts(exec, device, mountpoint);
  // The mountpoint dir must exist before `mount` (same as mounter.mountReadOnly).
  // It lives under /run (root-owned), so creating it needs sudo — without this
  // the mount fails with "mount point does not exist" and the worker never runs.
  await exec(['mkdir', '-p', mountpoint], { sudo: true });
  // outDir must be created before `podman run -v <outDir>:/out`. It lives on the
  // HOST (resolveHostDataDir), not in the container's /app/data (read-only on the
  // host). Fail fast if the mkdir fails — a read-only-filesystem error here means
  // the resolved host path is wrong (fell back to /app/data). The caller surfaces
  // the error; don't silently continue and let `podman run` fail with a confusing
  // "statfs: no such file or directory".
  const mkdirOut = await exec(['mkdir', '-p', outDir]);
  if (mkdirOut.code !== 0) {
    throw new Error(
      `disk-import: failed to create worker out dir ${outDir}: ${mkdirOut.stderr || mkdirOut.stdout}. ` +
      `Resolved host data dir was ${hostDataDir}; if that is the in-container /app/data, ` +
      `set HOST_DATA_DIR (or ensure servicebay's /app/data volume Source is inspectable).`,
    );
  }
  // SELinux is Enforcing on the box. Without a label the source filesystem is
  // `unlabeled_t` and the `container_t` worker gets EACCES on `scandir /mnt/src`.
  // `:z`/`:Z` on the `-v` bind is IMPOSSIBLE here — the source is a READ-ONLY
  // mount, so podman's `lsetxattr` relabel fails. Instead, label the whole
  // filesystem at MOUNT time with the SELinux `context=` mount option: the source
  // then carries `container_file_t` and the worker can read it (verified on-box).
  // The `-v …:ro` bind below intentionally stays plain `:ro` — the context-mounted
  // source already has the right label.
  await exec(
    ['mount', '-o', 'ro,context="system_u:object_r:container_file_t:s0"', device, mountpoint],
    { sudo: true },
  );

  // Resolve the Immich External-Library provisioning inputs (admin key + box
  // users) the worker's apply path needs (#1954). Injected as env so the apply
  // child inside the serve container inherits them; `[]` (no-op) when Immich
  // isn't installed / the key can't be resolved.
  const immichEnv = await resolveImmichProvisionEnv();

  await exec([
    'podman', 'run', '-d', '--rm',
    '--name', container,
    `--memory=${WORKER_MEMORY}`,
    `--memory-swap=${WORKER_MEMORY}`,
    '-p', `${WORKER_PORT}`,
    '-v', `${mountpoint}:/mnt/src:ro`,
    // `:z` relabels the out dir to a SHARED SELinux label so the worker can
    // write it — otherwise it keeps servicebay's private MCS categories and the
    // worker gets EACCES on /out/status.json even as root. Shared (`:z`) because
    // servicebay reads status/plan back from here. (#1955 box-verify.)
    '-v', `${outDir}:/out:z`,
    '-e', `DISK_IMPORT_RUN_ID=${runId}`,
    '-e', `DISK_IMPORT_SHARE_GID=${shareGid}`,
    ...immichEnv,
    WORKER_IMAGE,
    '--serve', '--share-gid', String(shareGid),
  ]);

  return { runId, outDir, container, device, mountpoint };
}

/**
 * Unmount EVERY mount of `device` at `mountpoint` and tear the dir down, so a
 * fresh mount can't stack on a leftover (#1941). Idempotent + best-effort: if
 * nothing is mounted, `umount` reports "not mounted" — we ignore that and any
 * other umount error so a cold/clean device never blocks the launch. `umount -A`
 * detaches all of the device's mounts in one go (clears a stack), then we drop
 * the (now-empty) controlled mountpoint dir.
 */
async function sweepDeviceMounts(exec: SafeExec, device: string, mountpoint: string): Promise<void> {
  assertSafeDevice(device);
  // `umount -A <device>` unmounts every mount of the device wherever it sits —
  // exactly the stacked-layer case the issue hit. Best-effort: ignore the
  // "not mounted" exit for a clean device. Then `umount -A <mountpoint>` mops up
  // any mount left there by a different device node (defence in depth).
  await exec(['umount', '-A', device], { sudo: true }).catch(() => undefined);
  await exec(['umount', '-A', mountpoint], { sudo: true }).catch(() => undefined);
  // Drop the now-empty controlled mountpoint dir (re-created before the mount).
  // `rmdir` (not `rm -rf`) — it only removes an EMPTY dir, so a still-mounted
  // path is left intact rather than risking a recursive delete into a mount.
  await exec(['rmdir', mountpoint], { sudo: true }).catch(() => undefined);
}

/**
 * Unmount a finished/aborted run's source device and remove its mountpoint
 * (#1941). Called on worker teardown so the one-shot `--rm` worker leaves no
 * mount behind. Best-effort + idempotent — ignores "not mounted"/missing-dir.
 */
export async function cleanupRunMount(exec: SafeExec, run: WorkerRun): Promise<void> {
  if (!run.device || !run.mountpoint) return;
  await sweepDeviceMounts(exec, run.device, run.mountpoint);
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

/**
 * Stop a worker container (the tile's "Start over" / abort) AND unmount its
 * source device (#1941). Both steps are best-effort so a half-gone run still
 * fully cleans up — and the unmount runs even if the container is already gone,
 * so a crashed worker's mount can't leak past teardown.
 */
export async function stopWorker(exec: SafeExec, run: WorkerRun): Promise<void> {
  await exec(['podman', 'rm', '-f', run.container]).catch(() => {});
  await cleanupRunMount(exec, run);
}

/** Ensure the worker image is present on the node (pull if missing). */
export async function ensureWorkerImage(exec: SafeExec): Promise<void> {
  const { stdout } = await exec(['podman', 'image', 'exists', WORKER_IMAGE]).catch(() => ({ stdout: '', stderr: '', code: 1 }));
  void stdout;
  await exec(['podman', 'pull', WORKER_IMAGE]);
}
