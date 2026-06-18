#!/usr/bin/env node
/**
 * backup-worker — one-shot, resource-capped container entrypoint (#1955).
 *
 * This is the heavy external/config backup path, moved OUT of the servicebay
 * control plane. servicebay launches this as a one-shot container:
 *
 *   podman run --rm --memory=2g \
 *     -v /mnt/data/stacks:/mnt/stacks:ro \
 *     -v <shared-out>:/out \
 *     -e BACKUP_RUN_ID=<id> \
 *     backup-worker --stacks /mnt/stacks --out /out --services home-assistant,authelia,nginx
 *
 * For each requested service it resolves the config dir under the RO-mounted
 * stacks root, applies the include/exclude/strip/transform manifest, copies the
 * config into a temp staging dir, and tars it to `<out>/<service>.tar` — all in
 * ITS OWN `--memory`-bounded process. It writes a COMPACT `status.json`
 * (phase/counts + a per-service rollup) frequently; servicebay reads only that +
 * streams each tar to the NAS one at a time. An OOM/kill of THIS container never
 * touches servicebay (feedback_control_plane_vs_worker).
 *
 * A live WAL-mode SQLite (NPM's database.sqlite) is snapshotted host-side by
 * servicebay BEFORE launch (it needs to exec into the running NPM container, which
 * the worker can't); the worker just stages the resulting `…sqlite.sb-backup`
 * under its canonical name when the npm-sqlite collector manifest sees it.
 *
 * Per-service failures do NOT abort the run — they land in the status `results`
 * as outcome "error"/"skip"; the container still exits 0 so servicebay reads a
 * terminal `done` (a vanished worker, not a clean done, is the real failure).
 */
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getServiceManifest,
  type ServiceBackupManifest,
} from '../engine/serviceManifest';
import { buildServiceBackupTar } from '../engine/staging';
import {
  STATUS_FILE,
  initialStatus,
  type ServiceBackupResult,
  type WorkerStatus,
} from '../contract/status';

/** Thrown for user-facing failures (bad args). */
export class WorkerArgError extends Error {}

export interface WorkerOptions {
  /** Path the host stacks root is mounted at (read-only) inside the container. */
  stacks: string;
  /** Shared out-volume dir the per-service tars + status.json are written to. */
  out: string;
  /** Services to back up (manifest names). */
  services: string[];
  /** Opaque run id (mirrors the servicebay launch handle). */
  runId: string;
}

export const USAGE = `Usage: backup-worker --stacks <path> --out <dir> --services a,b,c [--run-id <id>]

One-shot config-backup worker. For each service, walks its config dir under the
RO-mounted stacks root, applies the backup manifest, and writes <service>.tar plus
a compact status.json to the out-volume. Default is a read-only copy — it never
writes back into a stack.

Options:
  --stacks <path>     Host stacks root mounted read-only (e.g. /mnt/stacks)
  --out <dir>         Shared out-volume for <service>.tar + status.json
  --services <list>   Comma-separated service names to back up
  --run-id <id>       Run id (default: env BACKUP_RUN_ID or a random id)
  --help, -h          Show this help`;

const VALUE_ARGS = new Set(['--stacks', '--out', '--services', '--run-id']);

function defaultRunId(): string {
  return process.env.BACKUP_RUN_ID ?? Math.random().toString(36).slice(2, 14);
}

export function parseWorkerArgs(argv: string[]): WorkerOptions | { help: true } {
  const draft: Partial<WorkerOptions> & { services?: string[] } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (VALUE_ARGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new WorkerArgError(`Missing value for ${arg}`);
      if (arg === '--stacks') draft.stacks = value;
      else if (arg === '--out') draft.out = value;
      else if (arg === '--run-id') draft.runId = value;
      else draft.services = value.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      throw new WorkerArgError(`Unknown argument: ${arg}`);
    }
  }
  if (!draft.stacks) throw new WorkerArgError('--stacks is required');
  if (!draft.out) throw new WorkerArgError('--out is required');
  if (!draft.services || draft.services.length === 0) throw new WorkerArgError('--services is required');
  return {
    stacks: draft.stacks,
    out: draft.out,
    services: draft.services,
    runId: draft.runId ?? defaultRunId(),
  };
}

/** Resolve a service's config dir under the (RO-mounted) stacks root. */
export function resolveServiceDataDir(stacksRoot: string, manifest: ServiceBackupManifest): string {
  return path.join(stacksRoot, manifest.dataSubdir ?? manifest.service);
}

/**
 * When the npm-sqlite collector ran host-side, the consistent snapshot lives at
 * `data/database.sqlite.sb-backup`. Remap the manifest to stage THAT under the
 * canonical `data/database.sqlite` name (mirrors the backend producer's
 * post-collector manifest). A no-op for any other manifest, or when the snapshot
 * isn't present (servicebay then left the live file in place to copy as-is).
 */
export async function applyCollectorRemap(
  serviceDataDir: string,
  manifest: ServiceBackupManifest,
): Promise<ServiceBackupManifest> {
  if (manifest.collector?.kind !== 'npm-sqlite') return manifest;
  const snap = path.join(serviceDataDir, 'data/database.sqlite.sb-backup');
  try {
    await fs.access(snap);
  } catch {
    return manifest; // snapshot not taken — copy the live file under its own name
  }
  return {
    ...manifest,
    include: manifest.include.map(p => (p === 'data/database.sqlite' ? 'data/database.sqlite.sb-backup' : p)),
    renames: { 'data/database.sqlite.sb-backup': 'data/database.sqlite' },
  };
}

/** IO seam so the run is unit-testable without a real fs/tar. */
export interface WorkerIO {
  /** Stage + tar one service's config to `tarPath`; throws on "no config". */
  buildTar: (serviceDataDir: string, manifest: ServiceBackupManifest, tarPath: string) => Promise<{ files: number; bytes: number }>;
  /** Persist the compact status doc. */
  writeStatus: (out: string, status: WorkerStatus) => void;
}

/**
 * Run the worker: for each requested service, stage + tar its config into the
 * out-volume, ticking the compact status as it goes. Per-service failures are
 * captured into `results` (the run continues); the final phase is `done` unless
 * the whole run aborts. Returns the final status doc.
 */
export async function runWorker(opts: WorkerOptions, io: WorkerIO): Promise<WorkerStatus> {
  let status = initialStatus(opts.runId, opts.services.length);
  const tick = (patch: Partial<WorkerStatus>): void => {
    status = { ...status, ...patch, updatedAt: Date.now() };
    io.writeStatus(opts.out, status);
  };
  tick({ step: 'Starting config backup …' });

  const results: ServiceBackupResult[] = [];
  for (const service of opts.services) {
    const manifest = getServiceManifest(service);
    if (!manifest) {
      results.push({ service, ok: false, tarName: null, bytes: 0, files: 0, outcome: 'error', detail: `No backup manifest for service "${service}"` });
      tick({ processed: results.length, results: [...results], step: `Skipped ${service} (no manifest)` });
      continue;
    }
    tick({ step: `Backing up ${service} …` });
    const serviceDataDir = resolveServiceDataDir(opts.stacks, manifest);
    const tarName = `${service}.tar`;
    try {
      const effective = await applyCollectorRemap(serviceDataDir, manifest);
      const { files, bytes } = await io.buildTar(serviceDataDir, effective, path.join(opts.out, tarName));
      results.push({ service, ok: true, tarName, bytes, files, outcome: 'ok', detail: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "No config files to back up" is a skip (service has no config yet),
      // anything else is a real error — but neither aborts the run.
      const outcome = /No config files to back up/.test(message) ? 'skip' : 'error';
      results.push({ service, ok: false, tarName: null, bytes: 0, files: 0, outcome, detail: message });
    }
    tick({ processed: results.length, results: [...results] });
  }

  tick({ phase: 'done', results: [...results], step: `Done: ${results.filter(r => r.ok).length}/${results.length} services backed up` });
  return status;
}

/** Default (real) IO: the fs staging engine + atomic-write status. */
function realIO(): WorkerIO {
  return {
    buildTar: buildServiceBackupTar,
    writeStatus: (out, status) => {
      const file = path.join(out, STATUS_FILE);
      mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(status));
      renameSync(tmp, file); // atomic swap so a polling reader never sees a half file
    },
  };
}

async function main(): Promise<void> {
  const parsed = parseWorkerArgs(process.argv.slice(2));
  if ('help' in parsed) {
    console.log(USAGE);
    return;
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
