// Disk-import — thin control-plane facade over the worker container (#1953/#1954).
//
// RIP-AND-REPLACE of the old in-process orchestration (#1949): the walk/hash/
// classify/dedup/plan/apply no longer runs in servicebay's Node process (that
// OOM'd the control plane). servicebay now LAUNCHES the resource-capped worker
// container and reads the compact status.json it writes — nothing heavy ever
// enters this process. The disk-import UI moved into the worker image and is
// reached via a launch TILE; this facade is the small launch/status glue the
// tile's API routes call.

import type { SafeExec, ReplanRequest } from '@servicebay/disk-import-worker';
import { SHARE_DATA_ROOT, type WorkerStatus } from '@servicebay/disk-import-worker';

import { logger } from '@/lib/logger';

import {
  launchWorker,
  readStatus,
  isWorkerRunning,
  stopWorker,
  cleanupRunMount,
  ensureWorkerImage,
  type ImportDevice,
  type WorkerRun,
} from './launcher';
import { listImportDevices } from './devices';
import { setActiveRun, getActiveRun, clearActiveRun } from './runStore';
import { applyImport, replanImport, type ApplyImportResult } from './apply';

export type { ImportDevice } from './launcher';

/** Removable partitions the tile offers as an import source (host-side lsblk). */
export async function getImportDevices(exec: SafeExec): Promise<ImportDevice[]> {
  return listImportDevices(exec);
}

/**
 * Resolve the REAL gid that owns file-share's data dir, host-side, by `stat`ing
 * {@link SHARE_DATA_ROOT} (the same way `ensureSambaPosixUser` resolves the share
 * owner — `stat -c %g`). Imported files are chown'd to `core:<this gid>`, so it
 * MUST be the actual file-share group (973 on the box), not the stale 1024
 * fallback the route hard-codes — a wrong gid leaves the files in an unnamed
 * group the containers can't read. Falls back to `fallbackGid` only when the
 * stat can't produce a non-negative integer (share not deployed yet / unexpected
 * output); never throws.
 */
export async function resolveShareGid(exec: SafeExec, fallbackGid: number): Promise<number> {
  try {
    const { stdout, code } = await exec(['stat', '-c', '%g', SHARE_DATA_ROOT]);
    if (code === 0) {
      const parsed = Number.parseInt(stdout.trim(), 10);
      if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
    logger.warn(
      'DiskImport',
      `resolveShareGid: \`stat -c %g ${SHARE_DATA_ROOT}\` gave ${JSON.stringify(stdout.trim())} (exit ${code}) — using fallback ${fallbackGid}`,
    );
  } catch (e) {
    logger.warn('DiskImport', `resolveShareGid: stat failed — using fallback ${fallbackGid}`, e);
  }
  return fallbackGid;
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
  // Resolve the REAL file-share group gid host-side (the passed `shareGid` is only
  // the fallback) so the worker's apply chowns to `core:<file-share gid>`, never
  // the stale 1024 fallback (feedback_fileshare_relabel_crashloop).
  const shareGid = await resolveShareGid(args.exec, args.shareGid);
  // launchWorker resolves the HOST data dir itself (env → self-inspect via the
  // mounted podman socket → conventional default): the worker's out dir is
  // created + bind-mounted host-side via `podman run`, so it must be the box path
  // (/mnt/data/servicebay), never the in-container /app/data (read-only on host).
  const run = await launchWorker({ ...args, shareGid, runId });
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
/**
 * Re-plan the active run with the page's per-folder routing rules (#2000) WITHOUT
 * applying — re-routes/re-dedups per owner in the worker (over the live mount) and
 * rewrites plan.json + status.json so the tile poll reflects the new owner-aware
 * plan. Used to preview the effect of the routing picks before "Import now".
 */
export async function replanRun(exec: SafeExec, request: ReplanRequest): Promise<void> {
  const run = await getActiveRun();
  if (!run) throw new Error('disk-import: no active run to re-plan');
  await replanImport({ exec, runId: run.runId, container: run.container, request });
}

/**
 * Apply the active run. When `request` is given, RE-PLAN with the page's routing
 * rules first (#2000) so files land in `data/<owner>/<category>/…` and the dedup
 * splits per owner; then the host-apply applies the rewritten plan.json unchanged.
 */
export async function applyRun(
  exec: SafeExec,
  shareGid: number,
  request?: ReplanRequest,
): Promise<ApplyImportResult> {
  const run = await getActiveRun();
  if (!run) throw new Error('disk-import: no active run to apply');
  // #2000: re-plan with the routing rules BEFORE applying, so the host-apply reads
  // the owner-aware, per-owner-deduped plan.json. Skipped when no rules were sent
  // (a plain apply of the auto-sorted plan).
  if (request) {
    await replanImport({ exec, runId: run.runId, container: run.container, request });
  }
  // Resolve the REAL file-share group gid host-side — the passed `shareGid` is the
  // fallback. The apply chowns every copied file to `core:<this gid>`; a wrong gid
  // (the 1024 fallback) leaves files in an unnamed group the containers can't read
  // AND risks a non-core stray crash-looping file-share on its next redeploy
  // (feedback_fileshare_relabel_crashloop).
  const realGid = await resolveShareGid(exec, shareGid);
  const result = await applyImport({ exec, runId: run.runId, mountpoint: run.mountpoint, shareGid: realGid });
  // Apply succeeded — unmount the source device and forget the run (#1982) so the
  // USB doesn't leak a mount and a reopened tile lands on the picker, not a stale
  // "active run". Both are best-effort/idempotent (cleanupRunMount ignores
  // not-mounted/missing-dir), and only run on success: on an apply ERROR we throw
  // above WITHOUT cleanup, leaving the mount live for retry/inspection until the
  // user's explicit "Start over" (abortRun).
  await cleanupRunMount(exec, run);
  await clearActiveRun();
  return result;
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
