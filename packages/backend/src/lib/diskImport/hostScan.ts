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
  // The scan walk runs UNPRIVILEGED on purpose (read-only enumeration never
  // escalates — see hostExec.ts). On a real ext4 disk that means two things:
  //
  //  1. `lost+found` is root-owned 0700 and useless to us — prune it from the
  //     walk so `find` never even tries to descend it (`-path .../lost+found
  //     -prune`).
  //  2. Any OTHER root-0700 subdir we hit still makes `find` print a
  //     "Permission denied" line on stderr and exit 1, EVEN THOUGH it already
  //     streamed every readable entry to stdout. Treating that exit 1 as fatal
  //     threw away a perfectly good listing ("Scan disk fails", #1893). So we
  //     tolerate exit 1 WHEN stdout parses into at least one record (a partial
  //     find), and only error on a genuinely failed walk (no usable stdout).
  const { stdout, code, stderr } = await exec([
    'find', mountpoint,
    // Prune the ext4 `lost+found` (root 0700) before any `-type f` test so we
    // neither descend it nor emit a permission-denied line for it.
    '-name', 'lost+found', '-prune', '-o',
    '-type', 'f', '-printf', '%p\t%s\t%T@\\0',
  ]);
  const files = parseFindOutput(stdout);
  // `find` exits 1 on a permission-denied descent but still lists what it could
  // read. A partial walk (exit 1 WITH parsed records) is a success; only a walk
  // that produced no usable output is fatal.
  if (code !== 0 && files.length === 0) {
    throw new Error(`disk-import: scan walk failed (code ${code}): ${stderr}`);
  }
  return files;
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
  onProgress?: (hashed: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let hashed = 0;
  for (const record of records) {
    out.set(record.sourcePath, await hashSourceFile(exec, record.sourcePath));
    hashed += 1;
    onProgress?.(hashed, records.length);
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
