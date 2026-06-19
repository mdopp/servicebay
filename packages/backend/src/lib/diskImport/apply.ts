// Disk-import — HOST-side apply, run from servicebay (#1972, slice of #1949).
//
// THE FIX-FORWARD for "apply does nothing / rsync failed (code -1)": the worker
// container is SANDBOXED — rsync isn't installed there, `sudo` is ignored, and the
// host `file-share/data` isn't mounted, so its stub-exec apply could never land a
// byte. The worker now does ONLY the heavy scan/classify/dedup/PLAN (which is the
// OOM-prone part — feedback_control_plane_vs_worker — and stays capped). The
// privileged host-apply runs HERE, in servicebay, where the agent's real
// `safe_exec` runs `mkdir`/`rsync`/`chown` on the host as core (honoring `sudo`)
// and `file-share/data` actually exists.
//
// This is memory-safe: the byte copy is the rsync subprocess (it streams), and
// applyPlan already batches mkdir/chown across a chunk (#1898), so servicebay's
// Node heap stays bounded. The control plane never re-walks/re-hashes the whole
// disk — it reads the worker's compact plan.json + catalog sidecar from the shared
// out dir (host `${HOST_DATA_DIR}/disk-import-runs/<runId>/`, which servicebay sees
// in-container at `${DATA_DIR}/disk-import-runs/<runId>/`).
//
// SOURCE: the worker scanned at its OWN mountpoint (`mountBase`, e.g. `/mnt/src`),
// so the plan's `record.sourcePath`s are absolute under that container path. The
// host rsync must read the device at the HOST mountpoint servicebay mounted it at
// (`run.mountpoint`, under MOUNT_BASE) — the same read-only mount persists from the
// scan. We therefore REBASE every source path from `mountBase` → host mountpoint
// before applyPlan rsyncs it. The mount stays present until apply completes; the
// tile's "Start over" / teardown unmounts it.

import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  applyPlan,
  hashSourceFile,
  ImportCatalog,
  provisionExternalLibraries,
  scanLibrariesForOwners,
  STATUS_FILE,
  PLAN_SIDECAR_FILE,
  REPLAN_REQUEST_FILE,
  type SafeExec,
  type PlanSidecar,
  type WorkerStatus,
  type ImportRecord,
  type ReplanRequest,
} from '@servicebay/disk-import-worker';

import { DATA_DIR } from '@/lib/dirs';
import { logger } from '@/lib/logger';
import { resolveImmichProvision } from './immichProvisionEnv';

/** Where servicebay reads the worker's out dir IN-CONTAINER (same data as the
 *  host `${HOST_DATA_DIR}/disk-import-runs/<runId>` the worker bind-mounted). */
export function runOutDir(runId: string): string {
  return path.join(DATA_DIR, 'disk-import-runs', runId);
}

/**
 * Resolve a record's sha256 (the catalog row key) on the HOST, via the agent
 * `safe_exec` (`sha256sum`) — NOT an in-process `readFileSync`. servicebay's
 * control-plane container does NOT bind-mount the source device (only `/app/data`
 * + the podman socket), so the rebased host mountpoint
 * (`/run/servicebay/disk-import/<dev>/…`) is invisible in-process — a `readFileSync`
 * there threw ENOENT and landed ZERO bytes (#1983). Reading the bytes through the
 * same `exec` that already runs rsync/mkdir/chown on the host both works and keeps
 * the control plane memory-safe (no whole file in the Node heap). The applyPlan
 * call invokes this LAZILY (only on a real catalog collision + to key a written
 * file's row), so a clean apply hashes only the files it actually copies.
 */
function makeHostHashOf(exec: SafeExec): (record: ImportRecord) => Promise<string> {
  return record => hashSourceFile(exec, record.sourcePath);
}

/**
 * Rebase a plan's source paths from the worker mountBase (`/mnt/src`) to the host
 * mountpoint, so the HOST rsync reads the real device. Returns a NEW plan (the
 * records are shallow-cloned with the rewritten sourcePath; everything else —
 * target, action, size — is untouched). A path that doesn't start with mountBase
 * is left as-is (defensive; shouldn't happen for a worker-produced plan).
 */
export function rebasePlanSource(sidecar: PlanSidecar, hostMountpoint: string): PlanSidecar['plan'] {
  const base = sidecar.mountBase.replace(/\/+$/, '');
  const rebase = (p: string): string =>
    p === base ? hostMountpoint : p.startsWith(`${base}/`) ? path.join(hostMountpoint, p.slice(base.length + 1)) : p;
  return {
    ...sidecar.plan,
    items: sidecar.plan.items.map(it => ({ ...it, record: { ...it.record, sourcePath: rebase(it.record.sourcePath) } })),
  };
}

/** The worker container's in-container out path (its `-v <outDir>:/out` mount). */
const WORKER_OUT_IN_CONTAINER = '/out';

export interface ReplanImportArgs {
  /** servicebay's REAL agent SafeExec (runs `podman exec` on the host as core). */
  exec: SafeExec;
  /** The run whose plan.json to re-plan. */
  runId: string;
  /** The serve container name to `podman exec --replan` into (#2000). */
  container: string;
  /** The page's routing rules + disk-default owner. */
  request: ReplanRequest;
}

/**
 * RE-PLAN the active run with the page's per-folder routing rules (#2000).
 *
 * The re-plan must re-dedup PER OWNER (so a cross-owner duplicate lands in BOTH
 * owners' areas instead of being dropped as a `shared`-scope dupe) — which needs
 * CONTENT HASHING, and only the worker can hash (the source disk is bind-mounted
 * `/mnt/src` in the worker, NOT in servicebay's container — #1983). So servicebay
 * writes the routing rules into the shared out dir and `podman exec`s the running
 * serve container to re-plan in-place: it reads the existing plan.json (no re-scan),
 * re-routes/re-dedups over the live mount, and rewrites plan.json + status.json.
 * The subsequent host-apply then applies the rewritten plan.json UNCHANGED.
 */
export async function replanImport(args: ReplanImportArgs): Promise<void> {
  const { exec, runId, container, request } = args;
  const outDir = runOutDir(runId);
  // Write the request the worker reads. servicebay sees the out dir in-container at
  // runOutDir() (same bytes as the worker's host-bind-mounted /out), so a direct fs
  // write here lands in the worker's /out.
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, REPLAN_REQUEST_FILE), JSON.stringify(request), 'utf-8');

  // Run a one-shot `--replan` process IN the serve container (it has /mnt/src +
  // /out): reads replan-request.json + plan.json, re-plans over the live mount,
  // rewrites plan.json + status.json. The serve server keeps running alongside.
  const { code, stdout, stderr } = await exec([
    'podman', 'exec', container,
    'npx', 'tsx', 'packages/disk-import-worker/src/cli/main.ts',
    '--replan', '--out', WORKER_OUT_IN_CONTAINER,
  ]);
  if (code !== 0) {
    throw new Error(`disk-import: re-plan failed (code ${code}): ${stderr || stdout}`);
  }
}

/** Source device mountpoint inside the serve container (its `…:/mnt/src:ro` bind). */
const WORKER_SRC_IN_CONTAINER = '/mnt/src';

/**
 * Start the dry-run SCAN walk inside the already-launched serve container.
 *
 * The worker runs in `--serve` mode and only walks the disk when something POSTs
 * `/api/scan`. The original trigger was the in-browser worker app; the in-page
 * review flow has no such page, so launching a scan left the worker idle forever
 * ("Starting the import worker…" with no status.json). servicebay must kick it
 * off itself: a DETACHED (`-d`) one-shot `npx tsx main.ts --mount /mnt/src --out
 * /out` in the container — the same command the serve server spawns on POST —
 * which walks the live mount and writes status.json/plan.json while the serve
 * server keeps running for the review tree. Detached so the launch call returns
 * immediately (a real disk takes minutes); the page polls status.json.
 */
export async function triggerScan(exec: SafeExec, container: string, shareGid: number): Promise<void> {
  const { code, stdout, stderr } = await exec([
    'podman', 'exec', '-d', container,
    'npx', 'tsx', 'packages/disk-import-worker/src/cli/main.ts',
    '--mount', WORKER_SRC_IN_CONTAINER, '--out', WORKER_OUT_IN_CONTAINER,
    '--share-gid', String(shareGid),
  ]);
  if (code !== 0) {
    throw new Error(`disk-import: scan trigger failed (code ${code}): ${stderr || stdout}`);
  }
}

export interface ApplyImportArgs {
  /** servicebay's REAL agent SafeExec (runs mkdir/rsync/chown on the host as core). */
  exec: SafeExec;
  /** The run whose plan.json + catalog to apply. */
  runId: string;
  /** Host RO mountpoint of the source device (the rsync source root). */
  mountpoint: string;
  /** gid that owns file-share data — copies are chown'd to it, never a uid. */
  shareGid: number;
}

export interface ApplyImportResult {
  applied: number;
  photoOwners: string[];
  immichNote: string;
}

/**
 * Read the worker's plan.json + catalog from the out dir and APPLY it on the host
 * via applyPlan + servicebay's real exec. Streams status.json progress so the
 * tile's poll keeps reflecting the apply (phase `applying` → `done`/`error`). On
 * a photo-writing apply, fires the Immich External-Library provision + scan from
 * servicebay (it owns the secret store + LLDAP). Throws on a real apply failure
 * (so the route surfaces it) AFTER recording an `error`-phase status.
 */
export async function applyImport(args: ApplyImportArgs): Promise<ApplyImportResult> {
  const { exec, runId, mountpoint, shareGid } = args;
  const outDir = runOutDir(runId);

  const sidecar = JSON.parse(await readFile(path.join(outDir, PLAN_SIDECAR_FILE), 'utf-8')) as PlanSidecar;
  const plan = rebasePlanSource(sidecar, mountpoint);

  // Resume basis: the same catalog file the worker created in the out dir. Opened
  // in-container (better-sqlite3 is a backend dep); the out dir is the same bytes
  // host-side.
  const catalog = new ImportCatalog(path.join(outDir, 'catalog.sqlite'));

  // Seed the status doc so the tile poll keeps ticking through the apply. We patch
  // the worker's last status (its plan counts) rather than inventing a new one.
  let status = await readOutStatus(outDir, runId);
  const tick = async (patch: Partial<WorkerStatus>): Promise<void> => {
    status = { ...status, ...patch, mode: 'apply', updatedAt: Date.now() };
    await writeOutStatus(outDir, status);
  };
  await tick({ phase: 'applying', step: 'Applying plan …', applied: 0 });

  try {
    const result = await applyPlan(plan, {
      exec,
      mountpoint,
      catalog,
      shareGid,
      hashOf: makeHostHashOf(exec),
      onProgress: p => {
        // Fire-and-forget the progress write; a slow disk poll must not block rsync.
        void writeOutStatus(outDir, { ...status, mode: 'apply', applied: p.copied, updatedAt: Date.now() });
      },
    });
    catalog.close();

    // #1904/#1954: photos written → provision + scan the owning Immich libraries
    // from servicebay (it owns the admin key + LLDAP directory). Best-effort — the
    // files are already on disk; a scan failure must NOT fail the import.
    let immichNote = '';
    if (result.photoOwners.length > 0) immichNote = await provisionImmichForOwners(result.photoOwners);

    await tick({
      phase: 'done',
      applied: result.applied,
      step: `Applied ${result.applied} file(s).` + (immichNote ? ` ${immichNote}` : ''),
    });
    return { applied: result.applied, photoOwners: result.photoOwners, immichNote };
  } catch (e) {
    catalog.close();
    const message = e instanceof Error ? e.message : String(e);
    await tick({ phase: 'error', step: 'Apply failed', error: message });
    throw e;
  }
}

/**
 * Provision the per-owner Immich External Libraries and trigger the owning ones'
 * scan after a photo-writing apply (#1954, moved into servicebay). Never throws —
 * returns a one-line note for the status step.
 */
async function provisionImmichForOwners(photoOwners: string[]): Promise<string> {
  const provision = await resolveImmichProvision();
  if (!provision) return '';
  try {
    const { libraryIdByOwner } = await provisionExternalLibraries(provision.cfg, provision.boxUsers);
    await scanLibrariesForOwners(provision.cfg, libraryIdByOwner, photoOwners);
    return 'Immich External Libraries provisioned + scan triggered.';
  } catch (e) {
    logger.warn('disk-import:immich', `Immich library scan skipped: ${e instanceof Error ? e.message : String(e)}`);
    return `Immich library scan skipped: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Read the worker's last status.json, or a minimal apply-phase doc when absent. */
async function readOutStatus(outDir: string, runId: string): Promise<WorkerStatus> {
  try {
    return JSON.parse(await readFile(path.join(outDir, STATUS_FILE), 'utf-8')) as WorkerStatus;
  } catch {
    const now = Date.now();
    return {
      version: 1,
      runId,
      phase: 'applying',
      step: 'Applying plan …',
      mode: 'apply',
      scanned: 0,
      planned: 0,
      applied: 0,
      conflicts: 0,
      categories: [],
      totalBytes: 0,
      planSidecar: PLAN_SIDECAR_FILE,
      error: null,
      updatedAt: now,
      startedAt: now,
    };
  }
}

/** Atomic-ish status write (tmp + rename) so a polling reader never sees a half file. */
async function writeOutStatus(outDir: string, status: WorkerStatus): Promise<void> {
  const file = path.join(outDir, STATUS_FILE);
  const tmp = `${file}.tmp`;
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(tmp, JSON.stringify(status), 'utf-8');
    await rename(tmp, file);
  } catch {
    await writeFile(file, JSON.stringify(status), 'utf-8').catch(() => {});
  }
}
