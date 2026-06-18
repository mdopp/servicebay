// disk-import-worker — `--serve` mode entrypoint (#1953, slice of #1949).
//
// When servicebay launches the worker container to back the disk-import TILE, it
// runs it in SERVE mode: the container exposes the self-contained app (server.ts
// + appHtml.ts) AND runs the heavy scan/apply itself, over the device servicebay
// bind-mounts read-only at `/mnt/src`, writing the compact status.json + plan
// sidecar to the shared `/out` volume. The control plane reads only status.json.
//
// The device is fixed by the bind mount (servicebay already enumerated + mounted
// it host-side), so this server's job-launch runs the engine over `/mnt/src` —
// it does NOT re-enumerate or re-mount inside the container.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { startServer, fileReader, moduleDir, type ServerDeps } from './server';
import { runReplan, type ReplanIO, type ReplanRequest } from '../engine/replan';
import { PLAN_SIDECAR_FILE, STATUS_FILE } from '../contract/status';
import { hashFileContent, fingerprintFileContent } from '../cli/main';

/** The read-only mount + shared out paths the container is launched with. */
export interface ServeOptions {
  /** Path the source device is bind-mounted at, read-only (default /mnt/src). */
  mount: string;
  /** Shared out-volume for status.json + plan sidecar (default /out). */
  out: string;
  /** Port the app listens on inside the container. */
  port: number;
  /** Run id servicebay assigned this launch. */
  runId: string;
  /** gid that owns file-share data — apply chowns copies to it, never a uid. */
  shareGid: number;
}

/** Spawn the one-shot worker CLI as a detached child for a DRY-RUN scan pass. */
function launchWorkerChild(opts: ServeOptions): void {
  const cliEntry = path.join(moduleDir(), '..', 'cli', 'main.ts');
  const args = [
    'tsx', cliEntry,
    '--mount', opts.mount,
    '--out', opts.out,
    '--run-id', opts.runId,
    '--share-gid', String(opts.shareGid),
  ];
  const child = spawn('npx', args, { stdio: 'inherit', detached: true });
  child.unref();
}

/** Build the server deps for serve mode. */
export function serveDeps(opts: ServeOptions): ServerDeps {
  return {
    outDir: opts.out,
    readJson: fileReader(opts.out),
    // The device is pre-mounted by servicebay; the picker shows the one disk.
    listDevices: async () => [{ path: opts.mount, display: 'Imported disk' }],
    // The worker only SCANS/PLANS (it's sandboxed — no privileged host I/O, no
    // rsync, no host file-share mount). APPLY runs in servicebay over the host
    // mount (#1972), so serve mode never launches the stub `--apply` child:
    // `apply` is a no-op here and the control plane drives the real host apply.
    launchJob: async mode => {
      if (mode === 'dry-run') launchWorkerChild(opts);
    },
    // RE-PLAN runs IN-PROCESS here: serve mode has the device bind-mounted at
    // `opts.mount`, so the hashers can read the bytes to re-dedup per owner (the
    // control plane can't, #1983). Reads/rewrites plan.json + status in the out dir.
    replan: async request => {
      const plan = await runReplan(request, serveReplanIO(opts.out));
      return { planned: plan.items.length, conflicts: plan.conflicts.length };
    },
  };
}

/** fs-backed re-plan IO over the out dir, hashing via the live mount. */
function serveReplanIO(out: string): ReplanIO {
  const writeJson = async (file: string, data: unknown): Promise<void> => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    await fs.rename(tmp, file).catch(() => writeFileSync(file, JSON.stringify(data)));
  };
  return {
    readJson: fileReader(out),
    writePlanSidecar: sidecar => writeJson(path.join(out, PLAN_SIDECAR_FILE), sidecar),
    writeStatus: status => writeJson(path.join(out, STATUS_FILE), status),
    hashOf: hashFileContent,
    fingerprintOf: fingerprintFileContent,
  };
}

/** Re-export the request type for callers building the serve deps. */
export type { ReplanRequest };

/** Start the worker app server over the bind-mounted device + out volume. */
export function serve(opts: ServeOptions) {
  return startServer(serveDeps(opts), opts.port);
}
