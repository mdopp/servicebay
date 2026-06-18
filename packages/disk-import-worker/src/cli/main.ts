#!/usr/bin/env node
/**
 * disk-import-worker — one-shot, resource-capped container entrypoint (#1951).
 *
 * This is the heavy path, moved OUT of the servicebay control plane. servicebay
 * launches this as a one-shot container:
 *
 *   podman run --rm --memory=1g \
 *     -v /dev/<device>:/mnt/src:ro \
 *     -v <shared-out>:/out \
 *     -e DISK_IMPORT_RUN_ID=<id> \
 *     disk-import-worker --mount /mnt/src --out /out [--apply] [--catalog /out/catalog.sqlite]
 *
 * It walks the read-only mount, builds the inventory, classifies, dedups (lazy
 * hash), and plans — all in ITS OWN `--memory`-bounded process. It writes a
 * COMPACT `status.json` (step/phase/counts/error) frequently and the HEAVY plan
 * to `plan.json` (the sidecar) ONCE when planning completes. servicebay reads
 * only those files; an OOM/kill of THIS container never touches servicebay
 * (feedback_control_plane_vs_worker).
 *
 * Default mode is dry-run (plan only, no host writes). `--apply` copies files into
 * the shared out area. Per feedback_fileshare_relabel_crashloop, imported files
 * stay CORE-owned (the apply chowns to the file-share GID/core, never to a
 * per-user uid) so the next file-share `:Z` relabel doesn't crash-loop.
 *
 * The worker is NON-interactive: there is no readline review gate here (that gate
 * is servicebay's, before it launches `--apply`). This keeps the container a pure
 * one-shot batch job.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildInventory, type ScannedFile } from '../engine/inventory';
import { buildPlan, type HashResolver } from '../engine/dedup';
import { ImportCatalog } from '../engine/catalog';
import { applyPlan } from '../engine/plan';
import {
  immichProvisionFromEnv,
  provisionExternalLibraries,
  scanLibrariesForOwners,
} from '../engine/immichLibraries';
import type { SafeExec } from '../engine/hostExec';
import type { ImportPlan, ImportRecord } from '../engine/types';
import {
  STATUS_FILE,
  PLAN_SIDECAR_FILE,
  STATUS_CONTRACT_VERSION,
  initialStatus,
  summarizeCategories,
  type WorkerStatus,
  type PlanSidecar,
} from '../contract/status';

/** Thrown for user-facing failures (bad args). */
export class WorkerArgError extends Error {}

export interface WorkerOptions {
  /** Path the source device is mounted at (read-only) inside the container. */
  mount: string;
  /** Shared out-volume dir the status.json + plan sidecar are written to. */
  out: string;
  mode: 'dry-run' | 'apply';
  /** Catalog DB path (resume basis). `:memory:` for a dry-run. */
  catalog: string;
  /** Opaque run id (mirrors the servicebay session). */
  runId: string;
  /** gid that owns file-share data — copied files are chown'd to it, NOT to a
   *  per-user uid (feedback_fileshare_relabel_crashloop). */
  shareGid: number;
}

const DEFAULT_SHARE_GID = 1024;

export const USAGE = `Usage: disk-import-worker --mount <path> --out <dir> [--apply] [options]
       disk-import-worker --serve [--port <n>] [--mount <path>] [--out <dir>]

One-shot disk-import worker. Walks the read-only mount, plans the import, and
writes a compact status.json + plan sidecar to the out-volume. Default is dry-run
(plan only, no host writes).

In --serve mode the worker exposes the disk-import app (the lazy review tree) AND
runs the heavy scan/apply over the bind-mounted device — this is the mode
servicebay launches the container in to back the disk-import tile (#1953/#1954).

Options:
  --mount <path>     Path the source device is mounted at, read-only (default /mnt/src in --serve)
  --out <dir>        Shared out-volume for status.json + plan.json (default /out in --serve)
  --apply            Copy files into the shared out area (default: dry-run)
  --catalog <path>   Import catalog DB path (default: :memory: for dry-run)
  --run-id <id>      Run id (default: env DISK_IMPORT_RUN_ID or a random id)
  --share-gid <gid>  gid that owns file-share data (default: ${DEFAULT_SHARE_GID})
  --serve            Run the in-container app server instead of a one-shot job
  --port <n>         Port the --serve app listens on (default: env PORT or 8080)
  --help, -h         Show this help`;

interface ArgDraft {
  mount?: string;
  out?: string;
  mode?: 'dry-run' | 'apply';
  catalog?: string;
  runId?: string;
  shareGid: number;
  serve?: boolean;
  port?: number;
}

const VALUE_ARGS = new Set(['--mount', '--out', '--catalog', '--run-id', '--share-gid', '--port']);

function applyValueArg(draft: ArgDraft, arg: string, value: string | undefined): void {
  if (value === undefined) throw new WorkerArgError(`Missing value for ${arg}`);
  if (arg === '--mount') draft.mount = value;
  else if (arg === '--out') draft.out = value;
  else if (arg === '--catalog') draft.catalog = value;
  else if (arg === '--run-id') draft.runId = value;
  else if (arg === '--port') {
    const port = Number(value);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new WorkerArgError(`--port must be a valid port number, got "${value}"`);
    }
    draft.port = port;
  } else {
    const gid = Number(value);
    if (!Number.isInteger(gid) || gid < 0) {
      throw new WorkerArgError(`--share-gid must be a non-negative integer, got "${value}"`);
    }
    draft.shareGid = gid;
  }
}

/** Serve-mode options (the in-container app server). */
export interface ServeArgs {
  serve: true;
  mount: string;
  out: string;
  port: number;
  runId: string;
  shareGid: number;
}

function defaultRunId(): string {
  return process.env.DISK_IMPORT_RUN_ID ?? createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 12);
}

export function parseWorkerArgs(argv: string[]): WorkerOptions | ServeArgs | { help: true } {
  const draft: ArgDraft = { shareGid: DEFAULT_SHARE_GID };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    else if (arg === '--serve') draft.serve = true;
    else if (arg === '--apply') draft.mode = 'apply';
    else if (arg === '--dry-run') draft.mode = 'dry-run';
    else if (VALUE_ARGS.has(arg)) applyValueArg(draft, arg, argv[++i]);
    else throw new WorkerArgError(`Unknown argument: ${arg}`);
  }
  if (draft.serve) {
    return {
      serve: true,
      mount: draft.mount ?? '/mnt/src',
      out: draft.out ?? '/out',
      port: draft.port ?? (Number(process.env.PORT) || 8080),
      runId: draft.runId ?? defaultRunId(),
      shareGid: draft.shareGid,
    };
  }
  if (!draft.mount) throw new WorkerArgError('--mount is required');
  if (!draft.out) throw new WorkerArgError('--out is required');
  const mode = draft.mode ?? 'dry-run';
  const catalog = draft.catalog ?? (mode === 'apply' ? path.join(draft.out, 'catalog.sqlite') : ':memory:');
  const runId = draft.runId ?? defaultRunId();
  return { mount: draft.mount, out: draft.out, mode, catalog, runId, shareGid: draft.shareGid };
}

/** Read-only metadata walk of the mount. The engine never reads file contents. */
export async function walkMount(mount: string, fsImpl: typeof fs = fs): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fsImpl.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const st = await fsImpl.stat(full);
        out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(mount);
  return out;
}

/** Lazy sha256 of a file's bytes — the full hash, used only to CONFIRM a
 *  fingerprint collision (so a real backup disk is never read whole). */
export function hashFileContent(record: ImportRecord): string {
  return createHash('sha256').update(readFileSync(record.sourcePath)).digest('hex');
}

/** Bytes read from each end for the cheap dedup fingerprint (#1995). */
const FINGERPRINT_EDGE_BYTES = 64 * 1024;

/**
 * Cheap content FINGERPRINT: sha256 of (size + first 64KB + last 64KB) — reads
 * at most 128KB instead of the whole file. Two files with the same size AND
 * fingerprint are almost certainly identical; the planner still full-hashes
 * those to be sure, so this never causes a wrong dedup — it just avoids reading
 * hundreds of GB of same-size files on a backup disk (#1995).
 */
export function fingerprintFileContent(record: ImportRecord): string {
  const size = record.size;
  const h = createHash('sha256').update(String(size));
  const fd = openSync(record.sourcePath, 'r');
  try {
    if (size <= FINGERPRINT_EDGE_BYTES * 2) {
      const buf = Buffer.allocUnsafe(size);
      readSync(fd, buf, 0, size, 0);
      h.update(buf);
    } else {
      const head = Buffer.allocUnsafe(FINGERPRINT_EDGE_BYTES);
      readSync(fd, head, 0, FINGERPRINT_EDGE_BYTES, 0);
      const tail = Buffer.allocUnsafe(FINGERPRINT_EDGE_BYTES);
      readSync(fd, tail, 0, FINGERPRINT_EDGE_BYTES, size - FINGERPRINT_EDGE_BYTES);
      h.update(head).update(tail);
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/** IO seams — injected so the run is testable without a real device/agent. */
export interface WorkerIO {
  scan: (mount: string) => Promise<ScannedFile[]>;
  hashOf: HashResolver;
  /** Cheap fingerprint resolver for the two-tier dedup (#1995). */
  fingerprintOf: HashResolver;
  /** Persist the compact status doc (atomic-ish: caller passes the full object). */
  writeStatus: (out: string, status: WorkerStatus) => void;
  /** Persist the heavy plan sidecar once. */
  writePlanSidecar: (out: string, sidecar: PlanSidecar) => void;
  /** Build the host-apply SafeExec for --apply (lazy: never touched on dry-run). */
  makeExec: (opts: WorkerOptions) => SafeExec;
  /**
   * Best-effort: after photos were written, provision the per-owner Immich
   * External Libraries and trigger their scan (#1954). A no-op when Immich
   * provisioning isn't wired (env not injected / Immich not installed). MUST NOT
   * throw — the files are already on disk; a scan failure must not fail apply.
   * Returns a short note for the status step, or '' when nothing was done.
   */
  provisionImmich: (photoOwners: string[]) => Promise<string>;
}

/**
 * Run the worker: scan → inventory → plan, write the compact status + heavy plan
 * sidecar; on --apply, copy files. Returns the final status doc. Any failure is
 * captured into an `error`-phase status (the container still exits non-zero) so
 * servicebay sees a terminal state rather than a vanished worker.
 */
export async function runWorker(opts: WorkerOptions, io: WorkerIO): Promise<WorkerStatus> {
  let status = initialStatus(opts.runId, opts.mode);
  const tick = (patch: Partial<WorkerStatus>): void => {
    status = { ...status, ...patch, updatedAt: Date.now() };
    io.writeStatus(opts.out, status);
  };
  tick({ step: `Scanning ${opts.mount} …` });

  try {
    const files = await io.scan(opts.mount);
    tick({ scanned: files.length, phase: 'planning', step: `Planning ${files.length} files …` });

    const records = buildInventory(files);
    const catalog = new ImportCatalog(opts.catalog);
    let plan: ImportPlan;
    try {
      plan = buildPlan(records, io.hashOf, {
        catalog,
        fingerprintOf: io.fingerprintOf,
        // Live progress over the dedup fingerprint pass so a big disk never
        // looks hung (#1995). Throttled by buildPlan to ~every 1000 files.
        onProgress: (done, total) =>
          tick({ step: `Planning: deduplicating ${done}/${total} same-size files …` }),
      });
    } finally {
      if (opts.mode === 'dry-run') catalog.close();
    }

    const categories = summarizeCategories(plan);
    const totalBytes = plan.items.reduce((sum, i) => sum + i.record.size, 0);
    io.writePlanSidecar(opts.out, { version: STATUS_CONTRACT_VERSION, runId: opts.runId, plan, mountBase: opts.mount });
    tick({
      planned: plan.items.length,
      conflicts: plan.conflicts.length,
      categories,
      totalBytes,
      planSidecar: PLAN_SIDECAR_FILE,
    });

    if (opts.mode === 'dry-run') {
      tick({ phase: 'done', step: `Dry run complete: ${plan.items.length} items planned, nothing written.` });
      return status;
    }

    // --apply: copy into the shared out area. applyPlan keeps files core-owned
    // (chown to shareGid, never a per-user uid) — feedback_fileshare_relabel_crashloop.
    tick({ phase: 'applying', step: 'Applying plan …' });
    const exec = io.makeExec(opts);
    const result = await applyPlan(plan, {
      exec,
      mountpoint: opts.mount,
      catalog,
      shareGid: opts.shareGid,
      // applyPlan's hashOf is async (it hashes on the HOST via exec, #1983); the
      // CLI-only stub apply still reuses the sync in-process hasher, wrapped.
      hashOf: async record => io.hashOf(record),
    });
    catalog.close();

    // #1904/#1954: if photos were written, auto-provision the per-owner Immich
    // External Libraries and scan the owning ones so the new photos get indexed.
    // Best-effort — a provision/scan failure must NOT fail the import (the files
    // are safely on disk; a later provision+scan still finds them).
    let immichNote = '';
    if (result.photoOwners.length > 0) {
      immichNote = await io.provisionImmich(result.photoOwners);
    }

    const doneStep =
      `Applied ${result.applied} file(s).` + (immichNote ? ` ${immichNote}` : '');
    tick({ applied: result.applied, phase: 'done', step: doneStep });
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tick({ phase: 'error', step: 'Failed', error: message });
    throw error;
  }
}

/** Default (real) IO: fs walk, crypto hash, atomic-write status/plan, agent exec. */
function realIO(): WorkerIO {
  const writeJson = (file: string, data: unknown): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    // rename for an atomic swap so a polling reader never sees a half file
    fs.rename(tmp, file).catch(() => writeFileSync(file, JSON.stringify(data)));
  };
  return {
    scan: mount => walkMount(mount),
    hashOf: hashFileContent,
    fingerprintOf: fingerprintFileContent,
    writeStatus: (out, status) => writeJson(path.join(out, STATUS_FILE), status),
    writePlanSidecar: (out, sidecar) => writeJson(path.join(out, PLAN_SIDECAR_FILE), sidecar),
    makeExec: opts => {
      // PRODUCTION DOES NOT USE THIS. The worker is sandboxed — rsync isn't
      // installed, `sudo` is ignored, and the host file-share isn't mounted — so a
      // host apply can't land a byte here (it failed with "rsync failed (code -1)").
      // The real privileged host apply now runs in SERVICEBAY over the host mount
      // (#1972: packages/backend/src/lib/diskImport/apply.ts); serve mode no longer
      // launches an `--apply` child. This stub child_process SafeExec only backs the
      // standalone `--apply` CLI for tests. spawnSync is statically imported at the
      // top of this ESM module — there is no `require` global here.
      void opts;
      return (argv: string[]) => {
        const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
        return Promise.resolve({
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
          code: r.status ?? -1,
        });
      };
    },
    provisionImmich: realProvisionImmich,
  };
}

/**
 * Real Immich provision/scan after an --apply that wrote photos (#1954). Reads
 * the launcher-injected config from env; a no-op when it's absent (Immich not
 * installed / not wired). Never throws — returns a one-line note for the status
 * step (errors are reported as a "skipped" note, not a failure).
 */
export async function realProvisionImmich(photoOwners: string[]): Promise<string> {
  const provision = immichProvisionFromEnv();
  if (!provision) return '';
  try {
    const { libraryIdByOwner } = await provisionExternalLibraries(provision.cfg, provision.boxUsers);
    await scanLibrariesForOwners(provision.cfg, libraryIdByOwner, photoOwners);
    return 'Immich External Libraries provisioned + scan triggered.';
  } catch (e) {
    return `Immich library scan skipped: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function main(): Promise<void> {
  const parsed = parseWorkerArgs(process.argv.slice(2));
  if ('help' in parsed) {
    console.log(USAGE);
    return;
  }
  if ('serve' in parsed) {
    // Lazy import so the one-shot path never loads the http server module.
    const { serve } = await import('../server/index');
    serve(parsed);
    return; // server keeps the process alive
  }
  await runWorker(parsed, realIO());
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    if (error instanceof WorkerArgError) console.error(`error: ${error.message}`);
    else console.error(error);
    process.exitCode = 1;
  });
}
