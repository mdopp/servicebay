// External/config backup — worker orchestration (#1955, slice of #1949).
//
// The control-plane glue around the resource-capped backup worker. servicebay:
//   1. resolves the installed templates' `servicebay.backup` declarations into
//      manifests (#2858 slice C — the list is no longer a table in ServiceBay),
//   2. runs any host-side collector (NPM's consistent sqlite snapshot) — this
//      must stay in servicebay: it execs INTO the running NPM container, which the
//      worker can't reach,
//   3. launches ONE worker container over the RO-mounted stacks dir,
//   4. polls the compact status.json to completion (liveness via `podman ps`).
//
// The CALLER (producer.ts for the NAS push, systemBackup.ts for the archive)
// reads the produced tars (one at a time, bounded) and cleans up the run. This
// module never imports producer — the heavy NAS-write helpers stay there, and the
// launch/poll glue stays here, so there's no producer ↔ service import cycle.
//
// The heavy walk/copy/tar runs entirely in the worker's `--memory` cap — servicebay
// never holds the file lists or all the tars at once (the in-process path did, and
// OOM'd the box at ~5.3 GB, #1894 / feedback_control_plane_vs_worker).

import { setTimeout as sleep } from 'node:timers/promises';

import { AgentExecutor } from '@/lib/agent/executor';
import { resolveHostDataDir } from '@/lib/hostDataDir';
import { getConfig } from '@/lib/config';
import type { ServiceBackupManifest, WorkerStatus } from '@servicebay/backup-worker';
import { findServiceManifest } from '@servicebay/backup-worker';

import { resolveInstalledBackupManifests } from '../externalBackup/templateManifests';

import { runBackupCollector } from '../externalBackup/collector';
import {
  launchBackupWorker,
  readBackupStatus,
  isBackupWorkerRunning,
  stopBackupWorker,
  ensureBackupWorkerImage,
  readBackupTar,
  type BackupWorkerRun,
  type SafeExec,
} from './launcher';

/** Default on-disk location of the per-service stack dirs (HOST path). */
const DEFAULT_STACKS_DIR = '/mnt/data/stacks';

/** How long to wait between status polls while the worker runs. */
const POLL_INTERVAL_MS = 2_000;

/** Safety ceiling so a wedged worker can't poll forever. */
const POLL_TIMEOUT_MS = 30 * 60_000;

/** A completed worker run the caller consumes (reads tars, then cleans up). */
export interface BackupRun {
  exec: SafeExec;
  run: BackupWorkerRun;
  status: WorkerStatus;
  /**
   * Services whose staged copy is a LIVE copy rather than a torn-free snapshot
   * (#2877) — the collector could not take a consistent one. The NAS write
   * records this as `consistent: false` in the tar's meta sidecar, so a restore
   * knows what it has. Absent from the map means "consistent".
   */
  inconsistent?: ReadonlySet<string>;
}

/** Build the launcher's `SafeExec` seam over the agent's structured `safe_exec`. */
function makeExec(node: string): SafeExec {
  const executor = new AgentExecutor(node);
  // `check: false`: the SafeExec seam reports the exit code to the launcher
  // rather than throwing (#2737 made throwing the execSafe default).
  return (argv, options) => executor.execSafe(argv, { ...(options ?? {}), check: false });
}

/** The HOST stacks root (honours templateSettings.DATA_DIR). */
async function resolveStacksDir(): Promise<string> {
  return (await getConfig()).templateSettings?.DATA_DIR || DEFAULT_STACKS_DIR;
}

/**
 * The manifests the installed templates DECLARE (#2858 slice C). The gate is
 * now the declaration itself: a template contributes its own store plus any
 * `stores:` entry it declares on another name's behalf (the old `gateOn`
 * rows), so nothing can be listed here that no installed template asked for.
 */
async function selectInstalledBackupManifests(): Promise<ServiceBackupManifest[]> {
  return resolveInstalledBackupManifests();
}

/**
 * Run every host-side collector for the requested services BEFORE launching the
 * worker (the only one today is NPM's consistent sqlite snapshot, which execs into
 * the running NPM container and writes `database.sqlite.sb-backup` on disk; the
 * worker then stages that under the canonical name). Best-effort: a snapshot
 * failure is logged inside runBackupCollector, never fatal.
 */
async function runHostCollectors(
  manifests: readonly ServiceBackupManifest[],
  node: string,
): Promise<Set<string>> {
  const inconsistent = new Set<string>();
  for (const manifest of manifests) {
    if (!manifest.collector) continue;
    const result = await runBackupCollector(manifest, node);
    if (!result.consistent) inconsistent.add(manifest.service);
  }
  return inconsistent;
}

/**
 * Launch the worker, poll its status.json to a terminal phase, then return the
 * final status + the run handle. The caller owns cleanup (reading tars + removing
 * the out dir via {@link cleanupBackupRun}). Throws on launch failure or if the
 * worker vanishes without writing a terminal status.
 */
async function runWorkerToCompletion(
  exec: SafeExec,
  services: string[],
  manifests: ServiceBackupManifest[],
  stacksDir: string,
): Promise<BackupRun> {
  await ensureBackupWorkerImage(exec);
  const runId = Math.random().toString(36).slice(2, 14);
  // Resolve the HOST-side data dir at launch time (env → podman self-inspect of
  // the /app/data mount source → default), not the container-internal path —
  // the out volume must be created + bind-mounted on the host (#1966).
  const dataDir = await resolveHostDataDir(exec);
  const run = await launchBackupWorker({ exec, services, manifests, runId, dataDir, stacksDir });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const status = await readBackupStatus(exec, run);
    if (status && (status.phase === 'done' || status.phase === 'error')) {
      return { exec, run, status };
    }
    if (!(await isBackupWorkerRunning(exec, run))) {
      // The container is gone — read one last time in case it wrote a terminal
      // status just before exiting; otherwise it died mid-run.
      const final = await readBackupStatus(exec, run);
      if (final && (final.phase === 'done' || final.phase === 'error')) {
        return { exec, run, status: final };
      }
      throw new Error('backup-worker exited without writing a terminal status');
    }
    if (Date.now() > deadline) {
      await stopBackupWorker(exec, run);
      throw new Error('backup-worker timed out');
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Run a worker backup for an explicit service list (collectors first, launch,
 * poll to completion). Returns the run handle for the caller to read tars + clean
 * up. Throws if the run ended in an `error` phase (the caller still cleans up).
 */
export async function runBackupForServices(services: string[], node = 'Local'): Promise<BackupRun> {
  const exec = makeExec(node);
  const stacksDir = await resolveStacksDir();
  const resolved = await resolveInstalledBackupManifests();
  // Resolve each requested service against the declarations; a service whose
  // template declares nothing is passed through so the worker records it as a
  // visible per-service error rather than being dropped from the denominator.
  const manifests = services
    .map(s => findServiceManifest(resolved, s))
    .filter((m): m is ServiceBackupManifest => m !== undefined);
  const inconsistent = await runHostCollectors(manifests, node);
  const result = await runWorkerToCompletion(exec, services, manifests, stacksDir);
  if (result.status.phase === 'error') {
    await cleanupBackupRun(result.exec, result.run);
    throw new Error(result.status.error ?? 'backup-worker run failed');
  }
  return { ...result, inconsistent };
}

/**
 * Run a worker backup for every installed service with a manifest. Returns null
 * (no launch) when nothing is installed; otherwise the completed run handle.
 */
export async function runBackupForInstalled(node = 'Local'): Promise<BackupRun | null> {
  const services = (await selectInstalledBackupManifests()).map(m => m.service);
  if (services.length === 0) return null;
  return runBackupForServices(services, node);
}

/**
 * Stage every installed service's config via the worker for a system-backup
 * archive (#1955 — replaces systemBackup.stageServiceConfig's in-process agent
 * file-copy). Same as {@link runBackupForInstalled}; the caller extracts each tar
 * into the archive (rather than uploading to the NAS) and then calls
 * {@link cleanupBackupRun}.
 */
export async function stageInstalledServiceConfigViaWorker(node = 'Local'): Promise<BackupRun | null> {
  return runBackupForInstalled(node);
}

/** Read one produced tar from a completed run (for upload / archive extraction). */
export { readBackupTar };

/** Remove a completed run's out dir once its tars have been consumed. */
export async function cleanupBackupRun(exec: SafeExec, run: BackupWorkerRun): Promise<void> {
  await exec(['rm', '-rf', run.outDir]).catch(() => {});
}
