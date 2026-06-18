// External/config backup — worker orchestration (#1955, slice of #1949).
//
// The control-plane glue around the resource-capped backup worker. servicebay:
//   1. picks the installed services with a backup manifest,
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
import { HOST_DATA_DIR } from '@/lib/dirs';
import { getConfig } from '@/lib/config';
import {
  SERVICE_BACKUP_MANIFESTS,
  getBackupGate,
  getServiceManifest,
} from '@servicebay/backup-worker';
import type { WorkerStatus } from '@servicebay/backup-worker';

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
}

/** Build the launcher's `SafeExec` seam over the agent's structured `safe_exec`. */
function makeExec(node: string): SafeExec {
  const executor = new AgentExecutor(node);
  return (argv, options) => executor.execSafe(argv, options ?? {});
}

/** The HOST stacks root (honours templateSettings.DATA_DIR). */
async function resolveStacksDir(): Promise<string> {
  return (await getConfig()).templateSettings?.DATA_DIR || DEFAULT_STACKS_DIR;
}

/**
 * The installed services with a backup manifest, gated correctly (a sibling-store
 * entry like `home-assistant-zwave` gates on its parent template). Returns the
 * manifest service names to hand the worker.
 */
async function selectInstalledBackupServices(): Promise<string[]> {
  const installed = new Set(Object.keys((await getConfig()).installedTemplates ?? {}));
  return SERVICE_BACKUP_MANIFESTS.filter(m => installed.has(getBackupGate(m))).map(m => m.service);
}

/**
 * Run every host-side collector for the requested services BEFORE launching the
 * worker (the only one today is NPM's consistent sqlite snapshot, which execs into
 * the running NPM container and writes `database.sqlite.sb-backup` on disk; the
 * worker then stages that under the canonical name). Best-effort: a snapshot
 * failure is logged inside runBackupCollector, never fatal.
 */
async function runHostCollectors(services: string[], node: string): Promise<void> {
  for (const service of services) {
    const manifest = getServiceManifest(service);
    if (manifest?.collector) await runBackupCollector(manifest, node);
  }
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
  stacksDir: string,
): Promise<BackupRun> {
  await ensureBackupWorkerImage(exec);
  const runId = Math.random().toString(36).slice(2, 14);
  const run = await launchBackupWorker({ exec, services, runId, dataDir: HOST_DATA_DIR, stacksDir });

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
  await runHostCollectors(services, node);
  const result = await runWorkerToCompletion(exec, services, stacksDir);
  if (result.status.phase === 'error') {
    await cleanupBackupRun(result.exec, result.run);
    throw new Error(result.status.error ?? 'backup-worker run failed');
  }
  return result;
}

/**
 * Run a worker backup for every installed service with a manifest. Returns null
 * (no launch) when nothing is installed; otherwise the completed run handle.
 */
export async function runBackupForInstalled(node = 'Local'): Promise<BackupRun | null> {
  const services = await selectInstalledBackupServices();
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
