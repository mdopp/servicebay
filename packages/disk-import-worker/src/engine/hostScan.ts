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

import { JUNK_PATH_SEGMENTS } from './categories';
import type { ScannedFile } from './inventory';
import type { SafeExec } from './hostExec';
import type { ImportRecord } from './types';

/**
 * The directory names pruned at the `find` walk: `lost+found` (root-0700, useless
 * to us) plus every junk subtree segment (`node_modules`, `.git`, `.trash`, …).
 * Single-sourced from {@link JUNK_PATH_SEGMENTS} so the prune list and the engine's
 * junk classification never drift. Pruning here means a repo-heavy disk's
 * `node_modules`/`.git` never get enumerated, hashed or imported (#1932) — these
 * subtrees are near-identical across projects, so unpruned they all size-collide
 * and the dedup hash pass tries to hash every one ("Checking for duplicates…"
 * never finishes).
 */
const PRUNE_DIR_NAMES: ReadonlyArray<string> = ['lost+found', ...JUNK_PATH_SEGMENTS];

/**
 * Build the `find` argv that prunes {@link PRUNE_DIR_NAMES} before the `-type f`
 * test. Shape: `find <mount> \( -name node_modules -o -name .git -o … \) -prune
 * -o -type f -printf '%p\t%s\t%T@\0'`. The pruned subtrees are never descended,
 * so they're never enumerated, hashed or imported. The NUL-delimited `-printf`
 * output contract is unchanged (parseFindOutput depends on it).
 */
export function buildScanFindArgs(mountpoint: string): string[] {
  const pruneGroup: string[] = ['('];
  PRUNE_DIR_NAMES.forEach((name, i) => {
    if (i > 0) pruneGroup.push('-o');
    pruneGroup.push('-name', name);
  });
  pruneGroup.push(')');
  return [
    'find', mountpoint,
    ...pruneGroup, '-prune', '-o',
    '-type', 'f', '-printf', '%p\t%s\t%T@\\0',
  ];
}

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
  // escalates — see hostExec.ts). On a real ext4 disk that means three things:
  //
  //  1. `lost+found` is root-owned 0700 and useless to us — prune it from the
  //     walk so `find` never even tries to descend it.
  //  2. Junk subtrees (`node_modules`, `.git`, `.trash`, …) are pruned the same
  //     way (#1932): a repo-heavy disk's node_modules is huge and near-identical
  //     across projects, so unpruned it floods the inventory + the dedup hash
  //     pass with size-colliding files and "Checking for duplicates…" never
  //     finishes. Pruned, those subtrees never enter the inventory at all. The
  //     prune list is single-sourced from JUNK_PATH_SEGMENTS via PRUNE_DIR_NAMES.
  //  3. Any OTHER root-0700 subdir we hit still makes `find` print a
  //     "Permission denied" line on stderr and exit 1, EVEN THOUGH it already
  //     streamed every readable entry to stdout. Treating that exit 1 as fatal
  //     threw away a perfectly good listing ("Scan disk fails", #1893). So we
  //     tolerate exit 1 WHEN stdout parses into at least one record (a partial
  //     find), and only error on a genuinely failed walk (no usable stdout).
  const { stdout, code, stderr } = await exec(buildScanFindArgs(mountpoint));
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
 * How many paths to feed a single `sha256sum` invocation. Batching the hash
 * pass kills the per-file agent round-trip that made a 269k-file disk take
 * hours (#1898): instead of one `safe_exec` per file we hand `sha256sum` a whole
 * chunk of paths and parse its per-line output. Chunked (not one giant argv) to
 * stay clear of the host's `ARG_MAX`/argv limits on a huge disk.
 */
export const HASH_BATCH_SIZE = 256;

/**
 * Byte cap for a single `sha256sum` batch (#1937). The fixed 256-file count cap
 * alone blew up on real media: a batch that lands on a run of large videos
 * (each GBs) had to read hundreds of GB through `sha256sum` in ONE host call and
 * blew the exec timeout → the batch threw → the whole scan died ("failed after
 * ~130k files"). So a batch is flushed at {@link HASH_BATCH_SIZE} files OR when
 * its accumulated `record.size` reaches this cap, whichever comes first. 768 MB
 * is comfortably hashable within {@link batchTimeoutMs} even on slow USB media
 * (a few GB/min), so a batch of big videos contains just a handful of files.
 * Only the byte-aware {@link hashRecords} path knows sizes; the raw
 * {@link hashPaths} path (no sizes) keeps the count-only cap.
 */
export const HASH_BATCH_BYTES = 768 * 1024 * 1024;

/**
 * Per-batch exec timeout (#1937). The agent's `safe_exec` default (~30s) is far
 * too short for a media batch — hashing up to {@link HASH_BATCH_BYTES} off slow
 * USB at a few GB/min wants minutes, not seconds. We pass an explicit, generous
 * timeout that scales with the batch's byte budget (a small floor for tiny
 * batches). A batch that STILL times out is split + retried (never fatal).
 */
export const HASH_BATCH_TIMEOUT_FLOOR_MS = 60_000;

/** Generous timeout for a batch carrying `bytes` of content: floor + ~1 min per
 *  256 MB. Keeps even a worst-case (cap-sized) batch from spuriously timing out
 *  on slow media, while a tiny batch still gets a sane floor. */
function batchTimeoutMs(bytes: number): number {
  return HASH_BATCH_TIMEOUT_FLOOR_MS + Math.ceil(bytes / (256 * 1024 * 1024)) * 60_000;
}

/**
 * Build a dedup {@link import('./dedup').HashResolver} backed by host-side
 * `sha256sum` over the read-only mount. dedup only calls this for size-collision
 * candidates, so the host doesn't hash every file. Synchronous-looking resolver
 * contract: we pre-hash the candidate set up front (batched passes) so the
 * deterministic engine can stay synchronous.
 *
 * Throughput (#1898): paths are hashed in batches — one `sha256sum <p1> <p2> …`
 * agent round-trip per batch, not one per file.
 *
 * Resilience (#1937): this size-aware path flushes a batch at
 * {@link HASH_BATCH_SIZE} files OR {@link HASH_BATCH_BYTES} bytes (so a batch of
 * large media stays small + within the time budget), passes an explicit generous
 * {@link batchTimeoutMs}, and on a batch failure (timeout / non-zero exit) RETRIES
 * by splitting the batch down to per-file; a file that STILL fails is SKIPPED
 * (omitted from the map → simply not deduped) with a warning, never thrown. The
 * caller (a background pass since #1937) must survive a hashing hiccup, so this
 * degrades dedup gracefully instead of killing the scan.
 *
 * `onProgress` still fires once per (attempted) file so the card's live
 * `hashed/total` count advances smoothly.
 */
export async function hashRecords(
  exec: SafeExec,
  records: ImportRecord[],
  onProgress?: (hashed: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (records.length === 0) return out;
  for (const r of records) {
    if (r.sourcePath.includes('\0')) throw new Error('disk-import: NUL byte in source path');
  }
  const total = records.length;
  let processed = 0;
  let batch: ImportRecord[] = [];
  let batchBytes = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const paths = batch.map(r => r.sourcePath);
    const resolved = await hashBatchResilient(exec, paths, batchTimeoutMs(batchBytes));
    for (const [p, hex] of resolved) out.set(p, hex);
    processed += batch.length;
    onProgress?.(processed, total);
    batch = [];
    batchBytes = 0;
  };
  for (const r of records) {
    const size = Math.max(0, r.size);
    // Flush BEFORE adding when this record would push a NON-EMPTY batch over the
    // byte cap — so a run of large media yields one-file batches (each comfortably
    // under the exec timeout) instead of a doomed mega-batch. A single record
    // larger than the cap still goes alone (it can't be split further).
    if (batch.length > 0 && batchBytes + size > HASH_BATCH_BYTES) {
      await flush();
    }
    batch.push(r);
    batchBytes += size;
    if (batch.length >= HASH_BATCH_SIZE) {
      await flush();
    }
  }
  await flush();
  return out;
}

/**
 * Hash many source files via host `sha256sum` (read-only), batched in
 * {@link HASH_BATCH_SIZE} chunks — one `sha256sum <p1> <p2> …` agent round-trip
 * per chunk, not one per file (#1898). Returns a path→sha256 map keyed by the
 * EXACT input path. `sha256sum` prints one `<hex>  <path>` line per file (and,
 * for a path containing a backslash or newline, prefixes the line with `\` and
 * escapes `\`→`\\`, `\n`→`\\n`); we undo that escaping so the map keys match the
 * paths we passed in. `onProgress` (optional) fires once per file so a live
 * `hashed/total` count still advances within a chunk. Empty input → no round-trip.
 *
 * No `record.size` is available on this raw-path entry (the apply top-up), so it
 * keeps the count-only batch cap. It still retries-splits a failing batch and
 * skips a persistently-failing file (#1937) — a missing apply-hash is handled by
 * the caller's resolver (it only needs hashes for write targets).
 */
export async function hashPaths(
  exec: SafeExec,
  paths: string[],
  onProgress?: (hashed: number, total: number) => void,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  for (const p of paths) {
    if (p.includes('\0')) throw new Error('disk-import: NUL byte in source path');
  }
  const total = paths.length;
  let processed = 0;
  for (let i = 0; i < paths.length; i += HASH_BATCH_SIZE) {
    const chunk = paths.slice(i, i + HASH_BATCH_SIZE);
    const resolved = await hashBatchResilient(exec, chunk, batchTimeoutMs(0));
    for (const [p, hex] of resolved) out.set(p, hex);
    processed += chunk.length;
    onProgress?.(processed, total);
  }
  return out;
}

/**
 * Hash one batch of paths resiliently (#1937). One `sha256sum` round-trip with an
 * explicit `timeoutMs`; a NON-FATAL failure (timeout / non-zero exit / a path the
 * tool omitted) is recovered by SPLITTING the batch (halve, down to per-file) and
 * retrying each half. A single path that still fails at width 1 is SKIPPED
 * (omitted from the returned map → simply not deduped) with a warning. Never
 * throws for a hashing failure — the scan/review (already rendered, #1937 Part A)
 * must survive a hash-pass hiccup.
 */
async function hashBatchResilient(
  exec: SafeExec,
  paths: string[],
  timeoutMs: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  try {
    const byPath = parseSha256sumOutput(await runSha256sum(exec, paths, timeoutMs));
    let allPresent = true;
    for (const p of paths) {
      const hex = byPath.get(p);
      if (hex === undefined) {
        allPresent = false;
        break;
      }
      out.set(p, hex);
    }
    if (allPresent) return out;
    // The tool returned but omitted a requested path — fall through to split so
    // the present paths in this batch still get hashed.
    out.clear();
  } catch {
    // Timeout / non-zero exit / transport error — recover by splitting.
  }

  if (paths.length === 1) {
    // A single file that still fails: skip its hash (it just isn't deduped).
    console.warn(`disk-import: skipping un-hashable file (left un-deduped): ${JSON.stringify(paths[0])}`);
    return out;
  }
  const mid = Math.ceil(paths.length / 2);
  const left = await hashBatchResilient(exec, paths.slice(0, mid), timeoutMs);
  const right = await hashBatchResilient(exec, paths.slice(mid), timeoutMs);
  for (const [p, h] of left) out.set(p, h);
  for (const [p, h] of right) out.set(p, h);
  return out;
}

async function runSha256sum(exec: SafeExec, paths: string[], timeoutMs?: number): Promise<string> {
  const { stdout, code, stderr } = await exec(['sha256sum', ...paths], { timeoutMs });
  if (code !== 0) {
    throw new Error(`disk-import: sha256sum failed (code ${code}): ${stderr}`);
  }
  return stdout;
}

/** Parse `sha256sum`'s per-line `<hex>  <path>` output into a path→hex map. */
function parseSha256sumOutput(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const escaped = line.startsWith('\\');
    const body = escaped ? line.slice(1) : line;
    // `<hex><space><space><path>` — the hash is fixed-width, the path follows
    // exactly two spaces (`sha256sum` text mode). Split off the first token.
    const sep = body.indexOf('  ');
    const hex = sep === -1 ? '' : body.slice(0, sep);
    if (!/^[0-9a-f]{64}$/.test(hex)) {
      throw new Error(`disk-import: unexpected sha256sum output: ${JSON.stringify(line.slice(0, 80))}`);
    }
    let path = body.slice(sep + 2);
    if (escaped) path = path.replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    out.set(path, hex);
  }
  return out;
}

/**
 * Hash one source file's bytes via host `sha256sum` (read-only). STRICT (unlike
 * the batched {@link hashPaths}/{@link hashRecords}, which skip a persistently-
 * failing file): a single explicit hash request must succeed or throw, so a
 * caller asking for exactly one hash gets a clear failure rather than a silent
 * `undefined`.
 */
export async function hashSourceFile(exec: SafeExec, sourcePath: string): Promise<string> {
  if (sourcePath.includes('\0')) throw new Error('disk-import: NUL byte in source path');
  const byPath = parseSha256sumOutput(await runSha256sum(exec, [sourcePath]));
  const hex = byPath.get(sourcePath);
  if (hex === undefined) {
    throw new Error(`disk-import: sha256sum returned no hash for ${JSON.stringify(sourcePath)}`);
  }
  return hex;
}
