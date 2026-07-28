/**
 * #2423 — the planning-phase full hash must be O(chunk) memory, not O(filesize).
 *
 * `hashFileContent` is the `hashOf` resolver for planning, and planning runs
 * inside the `--memory=1g` worker container. A re-plan over an already-cataloged
 * multi-GB movie takes that full hash, so an eager whole-file read OOM-kills the
 * container (a SIGKILL, so no terminal status is ever written).
 *
 * These tests prove the READ PATTERN, not only the digest: the fs seam is
 * instrumented so every `readSync` is recorded, and a virtual file LARGER THAN
 * THE 1g CAP is hashed without a byte of whole-file materialization. The
 * digest-identity side (same sha256 as the eager implementation, across chunk
 * boundaries) is pinned in `main.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createReadStream, openSync, ftruncateSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { hashFileContent, HASH_CHUNK_BYTES, type HashFileIO } from './main';
import type { ImportRecord } from '../engine/types';

const rec = (sourcePath: string, size: number): ImportRecord =>
  ({ sourcePath, size, mtimeMs: 0 }) as ImportRecord;

/** A file of `size` bytes that never exists — reads are served from nothing and
 *  recorded, so a 1.25 GiB "file" costs no disk and no whole-file buffer. */
function virtualFile(size: number): {
  io: HashFileIO;
  reads: { requested: number; returned: number; buffer: Buffer }[];
  closed: number;
} {
  let remaining = size;
  const reads: { requested: number; returned: number; buffer: Buffer }[] = [];
  const state = { closed: 0 };
  const io: HashFileIO = {
    openSync: () => 7,
    readSync: (_fd, buffer, offset, length) => {
      const returned = Math.min(length, remaining);
      remaining -= returned;
      buffer.fill(0, offset, offset + returned); // deterministic bytes
      reads.push({ requested: length, returned, buffer });
      return returned;
    },
    closeSync: () => {
      state.closed += 1;
    },
  };
  return {
    io,
    reads,
    get closed() {
      return state.closed;
    },
  };
}

describe('hashFileContent memory profile (#2423)', () => {
  it('hashes a file bigger than the container 1g cap through ONE reusable 1MB buffer', () => {
    // 1.25 GiB — larger than the worker's `--memory=1g`, so the eager
    // implementation could not have survived this file at all.
    const size = 1280 * 1024 * 1024;
    const vf = virtualFile(size);

    const digest = hashFileContent(rec('/mnt/src/movies/huge.mkv', size), vf.io);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // (a) The whole file was consumed — this is a full hash, not a prefix hash.
    expect(vf.reads.reduce((n, r) => n + r.returned, 0)).toBe(size);

    // (b) No read ever asked for more than one chunk …
    expect(Math.max(...vf.reads.map(r => r.requested))).toBe(HASH_CHUNK_BYTES);
    // … and it took one read per chunk plus the final 0-byte EOF read.
    expect(vf.reads).toHaveLength(size / HASH_CHUNK_BYTES + 1);

    // (c) THE memory claim: a single buffer, one chunk wide, reused for all 1281
    // reads. Peak resident bytes are O(chunk) and independent of `size`.
    const buffers = new Set(vf.reads.map(r => r.buffer));
    expect(buffers.size).toBe(1);
    expect([...buffers][0].byteLength).toBe(HASH_CHUNK_BYTES);
    expect(HASH_CHUNK_BYTES).toBeLessThanOrEqual(1024 * 1024);

    // (d) The descriptor is closed even on this long loop.
    expect(vf.closed).toBe(1);
  }, 60_000);

  it('read count scales with the file while the buffer does not', () => {
    const small = 4 * HASH_CHUNK_BYTES;
    const big = 64 * HASH_CHUNK_BYTES;
    const vs = virtualFile(small);
    const vb = virtualFile(big);
    hashFileContent(rec('/mnt/src/small.bin', small), vs.io);
    hashFileContent(rec('/mnt/src/big.bin', big), vb.io);

    expect(vb.reads.length - vs.reads.length).toBe((big - small) / HASH_CHUNK_BYTES);
    // 16x the file, identical peak allocation.
    expect(Math.max(...vb.reads.map(r => r.buffer.byteLength))).toBe(
      Math.max(...vs.reads.map(r => r.buffer.byteLength)),
    );
  }, 60_000);

  it('closes the descriptor when a read fails mid-file', () => {
    const vf = virtualFile(8 * HASH_CHUNK_BYTES);
    const failing: HashFileIO = {
      ...vf.io,
      readSync: (fd, buffer, offset, length, position) => {
        if (vf.reads.length >= 3) throw new Error('EIO: bad sector');
        return vf.io.readSync(fd, buffer, offset, length, position);
      },
    };
    expect(() => hashFileContent(rec('/mnt/src/flaky.mkv', 8 * HASH_CHUNK_BYTES), failing)).toThrow(
      'EIO: bad sector',
    );
    expect(vf.closed).toBe(1);
  });

  it('on a REAL 256MB file: same digest as a streaming hash, ~no extra memory held', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sb-hash-big-'));
    const p = path.join(dir, 'sparse.bin');
    try {
      const size = 256 * 1024 * 1024;
      const fd = openSync(p, 'w');
      ftruncateSync(fd, size); // sparse: costs no real disk, reads as zeros
      closeSync(fd);

      // Independent oracle: node's own streaming hash over the same file.
      const oracleHash = createHash('sha256');
      await pipeline(createReadStream(p), oracleHash);
      const oracle = oracleHash.digest('hex');

      const before = process.memoryUsage().arrayBuffers;
      const digest = hashFileContent(rec(p, size));
      const held = process.memoryUsage().arrayBuffers - before;

      expect(digest).toBe(oracle);
      // The eager whole-file read showed a ~256MB spike right here.
      expect(held).toBeLessThan(32 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
