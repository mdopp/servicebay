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
import path from 'node:path';

import { startServer, fileReader, moduleDir, type ServerDeps } from './server';

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

/** Spawn the one-shot worker CLI as a detached child for a scan/apply pass. */
function launchWorkerChild(opts: ServeOptions, mode: 'dry-run' | 'apply'): void {
  const cliEntry = path.join(moduleDir(), '..', 'cli', 'main.ts');
  const args = [
    'tsx', cliEntry,
    '--mount', opts.mount,
    '--out', opts.out,
    '--run-id', opts.runId,
    '--share-gid', String(opts.shareGid),
    ...(mode === 'apply' ? ['--apply', '--catalog', path.join(opts.out, 'catalog.sqlite')] : []),
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
    launchJob: async mode => launchWorkerChild(opts, mode),
  };
}

/** Start the worker app server over the bind-mounted device + out volume. */
export function serve(opts: ServeOptions) {
  return startServer(serveDeps(opts), opts.port);
}
