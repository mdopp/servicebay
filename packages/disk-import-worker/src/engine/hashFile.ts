/**
 * The full-file sha256 used as the dedup `HashResolver` — ONE constant-memory
 * implementation shared by every caller (#2438).
 *
 * It lived in `cli/main.ts` (the capped worker's entrypoint) when #2423 made it
 * chunked; the legacy host-side `scripts/disk-import.ts` kept its own eager
 * `readFileSync` copy and so kept the OOM. Moving it into the engine — the layer
 * both already depend on — lets the script reuse it without pulling any
 * worker-only dependency (the CLI's spawn/status/immich/replan stack) into a
 * host-side script.
 */
import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync } from 'node:fs';

import type { ImportRecord } from './types';

/** Bytes held in memory at a time by the full hash. The peak allocation of
 *  `hashFileContent` is this buffer, whatever the file's size (#2423). */
export const HASH_CHUNK_BYTES = 1024 * 1024;

/** The fs seam `hashFileContent` reads through — injectable like `walkMount`'s
 *  `fsImpl`, so a test can prove the READ PATTERN (chunk-sized, one buffer) on a
 *  file far larger than anything it could put on disk. */
export interface HashFileIO {
  openSync: (path: string, flags: string) => number;
  readSync: (
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  closeSync: (fd: number) => void;
}

const realHashFileIO: HashFileIO = { openSync, readSync, closeSync };

/**
 * Lazy sha256 of a file's bytes — the full hash, taken only for a record whose
 * target is already in the catalog (a delta/re-plan), never to confirm a
 * fingerprint collision (so a real backup disk is never read whole).
 *
 * Read in fixed `HASH_CHUNK_BYTES` chunks through ONE reusable buffer: peak
 * memory is O(chunk), not O(filesize). The eager `readFileSync` this replaced
 * pulled the whole file in, so a re-plan over an already-cataloged multi-GB
 * movie OOM-killed the `--memory=1g` worker — a SIGKILL, which skips
 * `runWorker`'s catch, so the run vanished with no terminal status (#2423).
 * sha256 is a streaming hash, so the digest is byte-identical to hashing the
 * whole buffer in one `update()`.
 */
export function hashFileContent(record: ImportRecord, fsImpl: HashFileIO = realHashFileIO): string {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const fd = fsImpl.openSync(record.sourcePath, 'r');
  try {
    for (;;) {
      // position `null` ⇒ read from (and advance) the file's own offset.
      const read = fsImpl.readSync(fd, buf, 0, HASH_CHUNK_BYTES, null);
      if (read === 0) break;
      h.update(read === HASH_CHUNK_BYTES ? buf : buf.subarray(0, read));
    }
  } finally {
    fsImpl.closeSync(fd);
  }
  return h.digest('hex');
}
