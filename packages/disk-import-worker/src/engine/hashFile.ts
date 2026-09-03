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

/** Bytes read from each end for the cheap dedup fingerprint (#1995). */
const FINGERPRINT_EDGE_BYTES = 64 * 1024;

/**
 * Cheap content FINGERPRINT: sha256 of (size + 64KB head + 64KB middle + 64KB
 * tail) - reads at most 192KB instead of the whole file. This IS the dedup
 * identity (#1995): equal size+fingerprint is treated as the same content, with
 * no full-hash confirm, so a backup disk full of same-size duplicates is not
 * read whole. A head+middle+tail+size collision between two genuinely different
 * files is astronomically unlikely, and the import is copy-only over a READ-ONLY
 * source - worst case of a false match is one file not copied (still on the
 * disk), never data loss.
 *
 * It lived in `cli/main.ts` next to the CLI's real IO until #2747; the serve-mode
 * entrypoint (`server/index.ts`) needed it and reached back into the CLI - that is
 * the `cli/main.ts` -> `server/index.ts` -> `cli/main.ts` cycle that kept this whole
 * package out of `npm run check:deps`. Both hashers now live here, in the engine
 * layer both sides already depend on, so the edge only points one way.
 */
export function fingerprintFileContent(record: ImportRecord, fsImpl: HashFileIO = realHashFileIO): string {
  const size = record.size;
  const h = createHash('sha256').update(String(size));
  const fd = fsImpl.openSync(record.sourcePath, 'r');
  try {
    if (size <= FINGERPRINT_EDGE_BYTES * 3) {
      const buf = Buffer.allocUnsafe(size);
      fsImpl.readSync(fd, buf, 0, size, 0);
      h.update(buf);
    } else {
      const seg = Buffer.allocUnsafe(FINGERPRINT_EDGE_BYTES);
      for (const offset of [
        0,
        Math.floor(size / 2 - FINGERPRINT_EDGE_BYTES / 2),
        size - FINGERPRINT_EDGE_BYTES,
      ]) {
        fsImpl.readSync(fd, seg, 0, FINGERPRINT_EDGE_BYTES, offset);
        h.update(seg);
      }
    }
  } finally {
    fsImpl.closeSync(fd);
  }
  return h.digest('hex');
}
