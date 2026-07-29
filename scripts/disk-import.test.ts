// Tests for the disk-import CLI (#1696). The review gate is the safety: a
// dry run must touch NOTHING on the host (the host-apply seam is never built),
// and --apply must STOP for an explicit confirmation before any host I/O.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseDiskImportArgs,
  runDiskImport,
  walkMount,
  renderReport,
  summarizePlan,
  hashFileContent,
  DiskImportError,
  type DiskImportOptions,
  type DiskImportIO,
} from './disk-import';
import {
  buildInventory,
  buildPlan,
  hashFileContent as sharedHashFileContent,
  HASH_CHUNK_BYTES,
  type HashFileIO,
  type ImportRecord,
} from '@servicebay/disk-import-worker';

// A small fixture mount: a photo, a music track, a doc, and one junk file.
let mount: string;

beforeEach(() => {
  mount = mkdtempSync(path.join(tmpdir(), 'disk-import-'));
  mkdirSync(path.join(mount, 'pics'), { recursive: true });
  mkdirSync(path.join(mount, 'tunes'), { recursive: true });
  mkdirSync(path.join(mount, 'docs'), { recursive: true });
  writeFileSync(path.join(mount, 'pics', 'holiday.jpg'), 'JPEGDATA');
  writeFileSync(path.join(mount, 'tunes', 'song.mp3'), 'MP3DATA');
  writeFileSync(path.join(mount, 'docs', 'invoice.pdf'), 'PDFDATA');
  writeFileSync(path.join(mount, 'Thumbs.db'), 'JUNK');
});

afterEach(() => {
  rmSync(mount, { recursive: true, force: true });
});

function baseOpts(overrides: Partial<DiskImportOptions> = {}): DiskImportOptions {
  return {
    mount,
    mode: 'dry-run',
    catalog: ':memory:',
    node: 'default',
    shareGid: 1024,
    ...overrides,
  };
}

/** A spying IO seam: real fs walk + real hash, but host-apply is a spy. The
 *  returned `makeExec`/`confirm` are the EFFECTIVE seams on `io` (overrides
 *  win), so assertions always target what `runDiskImport` actually called. */
function spyIO(over: Partial<DiskImportIO> = {}): {
  io: DiskImportIO;
  logs: string[];
  makeExec: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
} {
  const logs: string[] = [];
  // The actual SafeExec is never expected to run in these tests; if it does the
  // assertion on makeExec/exec-calls catches it.
  const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  const io: DiskImportIO = {
    log: m => logs.push(m),
    confirm: vi.fn().mockResolvedValue(false),
    scan: m => walkMount(m),
    hashOf: r => `sha-${r.sourcePath}`,
    makeExec: vi.fn(() => exec),
    ...over,
  };
  return {
    io,
    logs,
    makeExec: io.makeExec as ReturnType<typeof vi.fn>,
    confirm: io.confirm as ReturnType<typeof vi.fn>,
  };
}

describe('parseDiskImportArgs', () => {
  it('defaults to dry-run when no mode flag is given (safe by default)', () => {
    const opts = parseDiskImportArgs(['--mount', '/m']);
    expect(opts).toMatchObject({ mount: '/m', mode: 'dry-run', catalog: ':memory:' });
  });

  it('parses --apply and a persistent catalog default', () => {
    const opts = parseDiskImportArgs(['--mount', '/m', '--apply']);
    expect(opts).toMatchObject({ mount: '/m', mode: 'apply' });
    expect((opts as DiskImportOptions).catalog).not.toBe(':memory:');
  });

  it('rejects --dry-run and --apply together', () => {
    expect(() => parseDiskImportArgs(['--mount', '/m', '--dry-run', '--apply'])).toThrow(DiskImportError);
  });

  it('requires --mount', () => {
    expect(() => parseDiskImportArgs(['--dry-run'])).toThrow(/--mount is required/);
  });

  it('validates --share-gid is a non-negative integer', () => {
    expect(() => parseDiskImportArgs(['--mount', '/m', '--share-gid', 'nope'])).toThrow(DiskImportError);
  });

  it('returns help for --help', () => {
    expect(parseDiskImportArgs(['--help'])).toEqual({ help: true });
  });
});

describe('walkMount', () => {
  it('returns every file as a metadata ScannedFile (no junk filtering yet)', async () => {
    const files = await walkMount(mount);
    expect(files).toHaveLength(4);
    expect(files.every(f => typeof f.size === 'number' && typeof f.mtimeMs === 'number')).toBe(true);
    expect(files.some(f => f.path.endsWith('holiday.jpg'))).toBe(true);
  });
});

describe('renderReport / summarizePlan', () => {
  it('rolls up per category and a move-plan summary', async () => {
    const files = await walkMount(mount);
    const plan = buildPlan(buildInventory(files), r => `sha-${r.sourcePath}`);
    const stats = summarizePlan(plan);
    expect(stats.get('photos')?.count).toBe(1);
    expect(stats.get('music')?.count).toBe(1);
    expect(stats.get('documents')?.count).toBe(1);
    expect(stats.get('junk')?.count).toBe(1);

    const report = renderReport(plan).join('\n');
    expect(report).toContain('SIZING REPORT');
    expect(report).toContain('MOVE PLAN');
    expect(report).toContain('photos');
  });
});

describe('runDiskImport — dry-run touches nothing', () => {
  it('prints the sizing report + move-plan and NEVER builds the host-apply seam', async () => {
    const { io, logs, makeExec, confirm } = spyIO();
    const result = await runDiskImport(baseOpts({ mode: 'dry-run' }), io);

    // Nothing applied.
    expect(result).toBeNull();
    // The host-apply seam was never even constructed, let alone called.
    expect(makeExec).not.toHaveBeenCalled();
    // No confirmation prompt in dry-run.
    expect(confirm).not.toHaveBeenCalled();

    const out = logs.join('\n');
    expect(out).toContain('SIZING REPORT');
    expect(out).toContain('MOVE PLAN');
    expect(out).toContain('Dry run: nothing was written');
  });

  it('dry-run is the default mode and still touches nothing', async () => {
    const { io, makeExec } = spyIO();
    const opts = parseDiskImportArgs(['--mount', mount]) as DiskImportOptions;
    const result = await runDiskImport({ ...opts, mount }, io);
    expect(result).toBeNull();
    expect(makeExec).not.toHaveBeenCalled();
  });
});

describe('runDiskImport — apply review gate', () => {
  it('requires confirmation BEFORE the host-apply seam is built/invoked', async () => {
    const callOrder: string[] = [];
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    const confirm = vi.fn(async () => {
      callOrder.push('confirm');
      return true;
    });
    const makeExec = vi.fn(() => {
      callOrder.push('makeExec');
      return exec;
    });
    const { io } = spyIO({ confirm, makeExec });

    await runDiskImport(baseOpts({ mode: 'apply' }), io);

    // Confirmation happened, and it happened before the host-apply seam.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(makeExec).toHaveBeenCalledTimes(1);
    expect(callOrder.indexOf('confirm')).toBeLessThan(callOrder.indexOf('makeExec'));
  });

  it('aborts with no host I/O when the operator declines at the gate', async () => {
    const { io, makeExec, confirm } = spyIO({ confirm: vi.fn().mockResolvedValue(false) });
    await expect(runDiskImport(baseOpts({ mode: 'apply' }), io)).rejects.toThrow(DiskImportError);
    expect(confirm).toHaveBeenCalledTimes(1);
    // Declined → the host-apply seam is never built.
    expect(makeExec).not.toHaveBeenCalled();
  });

  it('on confirm, drives the host-apply (rsync/chown via the SafeExec seam)', async () => {
    const execCalls: string[][] = [];
    const exec = vi.fn(async (argv: string[]) => {
      execCalls.push(argv);
      return { stdout: '', stderr: '', code: 0 };
    });
    const makeExec = vi.fn(() => exec);
    const { io } = spyIO({ confirm: vi.fn().mockResolvedValue(true), makeExec });

    const result = await runDiskImport(baseOpts({ mode: 'apply' }), io);
    expect(result).not.toBeNull();
    // The non-photo files were copied via rsync through the seam.
    const verbs = execCalls.map(a => a[0]);
    expect(verbs).toContain('rsync');
    expect(verbs).toContain('chown');
  });
});

// #2438 — this script's full hash used to be its own eager
// `createHash('sha256').update(readFileSync(record.sourcePath))`, i.e. the whole
// file in memory: the same OOM class #2423 fixed in the capped worker. It is now
// the worker engine's chunked implementation, shared rather than copied. These
// tests pin BOTH halves of the acceptance: the digest is byte-identical to the
// eager output, and the read pattern is O(chunk), not O(filesize).
describe('hashFileContent (#2438 — shared chunked hash, digest-identical)', () => {
  const rec = (sourcePath: string, size: number): ImportRecord =>
    ({ sourcePath, size, mtimeMs: 0 }) as ImportRecord;

  /** The implementation this replaced, verbatim: one eager readFileSync into
   *  one update(). Every digest below is compared against THIS. */
  const eagerHash = (p: string): string =>
    createHash('sha256').update(readFileSync(p)).digest('hex');

  it('is the worker engine implementation itself, not a second copy', () => {
    // A divergent copy is how the OOM survived #2423 in the first place: the
    // worker was fixed, this script kept its own. Same binding ⇒ can't recur.
    expect(hashFileContent).toBe(sharedHashFileContent);
  });

  it('matches the pre-fix eager digest for the files on a real mount', () => {
    for (const rel of [
      ['pics', 'holiday.jpg'],
      ['tunes', 'song.mp3'],
      ['docs', 'invoice.pdf'],
    ]) {
      const p = path.join(mount, ...rel);
      expect(hashFileContent(rec(p, readFileSync(p).length)), p).toBe(eagerHash(p));
    }
  });

  it('matches the pre-fix eager digest across every chunk boundary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sb-script-hash-'));
    try {
      // Empty, sub-chunk, chunk±1 and multi-chunk-with-remainder: a byte-identical
      // digest at each pins the chunk-boundary handling (a dropped or reordered
      // chunk, or a stale tail of the reused buffer, changes the digest).
      const sizes = [
        0,
        1,
        HASH_CHUNK_BYTES - 1,
        HASH_CHUNK_BYTES,
        HASH_CHUNK_BYTES + 1,
        2 * HASH_CHUNK_BYTES + 12345,
      ];
      for (const size of sizes) {
        const p = path.join(dir, `f-${size}`);
        const bytes = Buffer.allocUnsafe(size);
        for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + (i >> 13)) & 0xff;
        writeFileSync(p, bytes);
        expect(hashFileContent(rec(p, size)), `size ${size}`).toBe(eagerHash(p));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hashes a file far larger than memory through ONE chunk-sized buffer', () => {
    // 256 MiB served from nothing — 256× the chunk, and more than the eager
    // version could have held without the OOM. Reads are recorded, so the
    // memory claim is asserted on the READ PATTERN, not inferred. (Size is kept
    // to what hashes comfortably inside the default 5s budget: the bound proven
    // here is O(chunk) regardless of length, so a bigger number buys nothing but
    // flake risk — #2431.)
    const size = 256 * HASH_CHUNK_BYTES;
    let remaining = size;
    const reads: { requested: number; returned: number; buffer: Buffer }[] = [];
    let closed = 0;
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
        closed += 1;
      },
    };

    const digest = hashFileContent(rec('/mnt/src/movies/huge.mkv', size), io);

    // Peak allocation is one chunk buffer, reused for every read.
    expect(new Set(reads.map(r => r.buffer)).size).toBe(1);
    expect(reads[0].buffer.byteLength).toBe(HASH_CHUNK_BYTES);
    expect(Math.max(...reads.map(r => r.requested))).toBe(HASH_CHUNK_BYTES);
    expect(reads).toHaveLength(size / HASH_CHUNK_BYTES + 1); // + the final 0-byte read
    expect(closed).toBe(1); // fd released even on the long path

    // …and the digest is still the sha256 of those bytes — computed here at a
    // DIFFERENT chunk size, so it also pins chunking-invariance.
    const expected = createHash('sha256');
    const zeros = Buffer.alloc(64 * 1024);
    for (let left = size; left > 0; left -= zeros.length) expected.update(zeros);
    expect(digest).toBe(expected.digest('hex'));
  });

  it('the script wires this hash in and keeps no eager readFileSync copy', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'disk-import.ts'),
      'utf8',
    );
    const imported = /import \{([\s\S]*?)\} from '@servicebay\/disk-import-worker';/.exec(src);
    expect(imported?.[1]).toContain('hashFileContent');
    // The real IO seam resolves dedup hashes through it …
    expect(src).toMatch(/hashOf: hashFileContent,/);
    // … and the eager whole-file read is gone for good: the script hashes
    // nothing itself, so it can neither read a file whole nor grow a second
    // divergent copy of the hash.
    expect(src).not.toMatch(/readFileSync\(/);
    expect(src).not.toMatch(/createHash\(/);
  });
});
