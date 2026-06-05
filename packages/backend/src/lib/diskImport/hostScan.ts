// Disk-import — host-side scan helpers for the UI card (issue #1697).
//
// The backend container cannot see the raw USB mount, so the directory walk and
// content hashing (for dedup) both run HOST-side via the agent's `safe_exec`
// path (structured argv, allow-listed binaries — `find` + `sha256sum`). These
// helpers are the only place the scan phase touches the host, and they only
// ever READ: the source is mounted `-o ro` (mounter.ts), `find` lists it, and
// `sha256sum` reads bytes — nothing here writes to the disk.
//
// The deterministic engine (inventory/classify/dedup) stays pure and host-free;
// it consumes the ScannedFile[] this module produces and calls back into
// `hashSourceFile` (as the dedup `HashResolver`) only for size-collision
// candidates.

import type { ScannedFile } from './inventory';
import type { SafeExec } from './hostExec';
import type { ImportRecord } from './types';

/** A `\0`-free absolute mountpoint we built ourselves (mounter.ts). */
function assertMountpoint(mountpoint: string): void {
  if (!mountpoint.startsWith('/') || mountpoint.includes('\0')) {
    throw new Error(`disk-import: refusing unsafe scan mountpoint: ${JSON.stringify(mountpoint)}`);
  }
}

/**
 * Host-walk `mountpoint` and return a metadata-only ScannedFile list. Uses
 * `find -type f -printf` with a NUL record separator so file names containing
 * spaces / newlines / quotes can't corrupt the parse. Each record carries the
 * absolute source path, size (bytes) and mtime (epoch seconds → ms). No hashing
 * here — that's deferred to {@link hashSourceFile}, called lazily by dedup.
 */
export async function scanMount(exec: SafeExec, mountpoint: string): Promise<ScannedFile[]> {
  assertMountpoint(mountpoint);
  // `%p\t%s\t%T@\0` — path, size, mtime (float epoch seconds), then a NUL. The
  // tab can't appear in `%s`/`%T@`, and the path is the first field, so a tab in
  // a filename is harmless (we split on the LAST two tabs).
  const { stdout, code, stderr } = await exec([
    'find', mountpoint, '-type', 'f', '-printf', '%p\t%s\t%T@\\0',
  ]);
  if (code !== 0) {
    throw new Error(`disk-import: scan walk failed (code ${code}): ${stderr}`);
  }
  return parseFindOutput(stdout);
}

/** Parse the NUL-separated `find -printf '%p\t%s\t%T@\0'` stream. */
export function parseFindOutput(stdout: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length === 0) continue;
    // Split off the last two tab-separated fields (size, mtime); everything
    // before them is the path (which may itself contain tabs).
    const lastTab = record.lastIndexOf('\t');
    if (lastTab === -1) continue;
    const sizeTab = record.lastIndexOf('\t', lastTab - 1);
    if (sizeTab === -1) continue;
    const path = record.slice(0, sizeTab);
    const size = Number(record.slice(sizeTab + 1, lastTab));
    const mtimeSec = Number(record.slice(lastTab + 1));
    if (!path || !Number.isFinite(size) || !Number.isFinite(mtimeSec)) continue;
    out.push({ path, size, mtimeMs: Math.round(mtimeSec * 1000) });
  }
  return out;
}

/**
 * Build a dedup {@link import('./dedup').HashResolver} backed by host-side
 * `sha256sum` over the read-only mount. dedup only calls this for size-collision
 * candidates, so the host doesn't hash every file. Synchronous-looking resolver
 * contract: we pre-hash the candidate set up front (one batched pass) so the
 * deterministic engine can stay synchronous.
 */
export async function hashRecords(
  exec: SafeExec,
  records: ImportRecord[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const record of records) {
    out.set(record.sourcePath, await hashSourceFile(exec, record.sourcePath));
  }
  return out;
}

/** Hash one source file's bytes via host `sha256sum` (read-only). */
export async function hashSourceFile(exec: SafeExec, sourcePath: string): Promise<string> {
  if (sourcePath.includes('\0')) {
    throw new Error('disk-import: NUL byte in source path');
  }
  const { stdout, code, stderr } = await exec(['sha256sum', sourcePath]);
  if (code !== 0) {
    throw new Error(`disk-import: sha256sum failed (code ${code}): ${stderr}`);
  }
  // `sha256sum` prints `<hex>  <path>`; take the first whitespace-delimited token.
  const hex = stdout.trim().split(/\s+/, 1)[0];
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`disk-import: unexpected sha256sum output: ${JSON.stringify(stdout.slice(0, 80))}`);
  }
  return hex;
}
