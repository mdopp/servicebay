// Disk-import — thin control-plane facade over the worker container (#1953/#1954).
//
// RIP-AND-REPLACE of the old in-process orchestration (#1949): the walk/hash/
// classify/dedup/plan/apply no longer runs in servicebay's Node process (that
// OOM'd the control plane). servicebay now LAUNCHES the resource-capped worker
// container and reads the compact status.json it writes — nothing heavy ever
// enters this process. The disk-import UI moved into the worker image and is
// reached via a launch TILE; this facade is the small launch/status glue the
// tile's API routes call.

import type { SafeExec } from '@servicebay/disk-import-worker';
import type { WorkerStatus } from '@servicebay/disk-import-worker';

import {
  launchWorker,
  readStatus,
  isWorkerRunning,
  stopWorker,
  ensureWorkerImage,
  type ImportDevice,
  type WorkerRun,
} from './launcher';
import { listImportDevices } from './devices';
import { setActiveRun, getActiveRun, clearActiveRun } from './runStore';
import { applyImport, type ApplyImportResult } from './apply';

export type { ImportDevice } from './launcher';

/** Removable partitions the tile offers as an import source (host-side lsblk). */
export async function getImportDevices(exec: SafeExec): Promise<ImportDevice[]> {
  return listImportDevices(exec);
}

/**
 * Launch a worker container to scan `device` (read-only). Pulls the worker image
 * if absent, mounts the device, runs the container detached, and persists the run
 * handle so a reopened tile re-attaches. Returns the run id; the worker app is
 * then reachable behind the proxy and writes status.json the tile polls.
 */
export async function launchScan(args: {
  exec: SafeExec;
  device: string;
  shareGid: number;
}): Promise<{ runId: string }> {
  const runId = randomRunId();
  await ensureWorkerImage(args.exec);
  // launchWorker resolves the HOST data dir itself (env → self-inspect via the
  // mounted podman socket → conventional default): the worker's out dir is
  // created + bind-mounted host-side via `podman run`, so it must be the box path
  // (/mnt/data/servicebay), never the in-container /app/data (read-only on host).
  const run = await launchWorker({ ...args, runId });
  await setActiveRun(run);
  return { runId: run.runId };
}

/** The current worker run's compact status + liveness, or null when none. */
export interface RunStatus {
  runId: string;
  /** The compact status doc the worker wrote (null before its first write). */
  status: WorkerStatus | null;
  /** `podman ps` liveness — true while the worker container is up. */
  running: boolean;
}

export async function getRunStatus(exec: SafeExec): Promise<RunStatus | null> {
  const run = await getActiveRun();
  if (!run) return null;
  const [status, running] = await Promise.all([readStatus(exec, run), isWorkerRunning(exec, run)]);
  return { runId: run.runId, status, running };
}

/**
 * Apply the active run's APPROVED plan ON THE HOST (#1972). The worker only
 * scanned/planned (it's sandboxed — it can't do privileged host I/O); servicebay
 * reads the worker's plan.json + catalog from the out dir and runs applyPlan with
 * its REAL agent exec, reading the source from the HOST mountpoint the device is
 * still mounted at. Status.json is updated through the apply so the tile poll keeps
 * reflecting progress. Throws when there's no active run, or on a real apply error.
 */
export async function applyRun(exec: SafeExec, shareGid: number): Promise<ApplyImportResult> {
  const run = await getActiveRun();
  if (!run) throw new Error('disk-import: no active run to apply');
  return applyImport({ exec, runId: run.runId, mountpoint: run.mountpoint, shareGid });
}

/** Stop the active worker container and forget it (the tile's "Start over"). */
export async function abortRun(exec: SafeExec): Promise<void> {
  const run = await getActiveRun();
  if (run) await stopWorker(exec, run);
  await clearActiveRun();
}

/** Re-exported for tests / the launch route. */
export type { WorkerRun };

function randomRunId(): string {
  return Math.random().toString(36).slice(2, 14);
}
