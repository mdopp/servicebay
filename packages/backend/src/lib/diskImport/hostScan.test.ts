import { describe, it, expect, vi } from 'vitest';
import { parseFindOutput, scanMount, hashSourceFile, hashRecords, hashPaths, HASH_BATCH_SIZE, buildScanFindArgs } from './hostScan';
import { JUNK_PATH_SEGMENTS } from './categories';
import type { SafeExec, SafeExecResult } from './hostExec';
import type { ImportRecord } from './types';

const ok = (stdout = ''): SafeExecResult => ({ stdout, stderr: '', code: 0 });

function mockExec(
  byBinary: Record<string, SafeExecResult | ((argv: string[]) => SafeExecResult)> = {},
): { exec: SafeExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: SafeExec = vi.fn(async (argv: string[]) => {
    calls.push(argv);
    const handler = byBinary[argv[0]];
    if (handler === undefined) return ok();
    return typeof handler === 'function' ? handler(argv) : handler;
  });
  return { exec, calls };
}

describe('parseFindOutput', () => {
  it('parses NUL-separated %p\\t%s\\t%T@ records, mtime sec → ms', () => {
    const out = parseFindOutput('/mnt/a.jpg\t1024\t1700000000.5\0/mnt/b.txt\t42\t1700000001\0');
    expect(out).toEqual([
      { path: '/mnt/a.jpg', size: 1024, mtimeMs: 1700000000500 },
      { path: '/mnt/b.txt', size: 42, mtimeMs: 1700000001000 },
    ]);
  });

  it('tolerates a tab inside the file path (splits on the last two tabs)', () => {
    const out = parseFindOutput('/mnt/weird\tname.mp3\t500\t1700000000\0');
    expect(out).toEqual([{ path: '/mnt/weird\tname.mp3', size: 500, mtimeMs: 1700000000000 }]);
  });

  it('skips empty / malformed records', () => {
    expect(parseFindOutput('')).toEqual([]);
    expect(parseFindOutput('garbage-no-tabs\0')).toEqual([]);
  });
});

describe('scanMount', () => {
  it('host-walks the mount with find -type f -printf and returns ScannedFiles', async () => {
    const { exec, calls } = mockExec({
      find: ok('/mnt/x/a.jpg\t10\t1700000000\0'),
    });
    const files = await scanMount(exec, '/run/servicebay/disk-import/sda1');
    expect(calls[0][0]).toBe('find');
    expect(calls[0]).toContain('-type');
    expect(calls[0]).toContain('f');
    expect(files).toEqual([{ path: '/mnt/x/a.jpg', size: 10, mtimeMs: 1700000000000 }]);
  });

  it('refuses an unsafe (non-absolute) mountpoint and never reaches the host', async () => {
    const { exec, calls } = mockExec();
    await expect(scanMount(exec, 'relative/path')).rejects.toThrow(/unsafe scan mountpoint/);
    expect(calls).toHaveLength(0);
  });

  it('throws on a non-zero find exit', async () => {
    const { exec } = mockExec({ find: { stdout: '', stderr: 'boom', code: 1 } });
    await expect(scanMount(exec, '/run/servicebay/disk-import/sda1')).rejects.toThrow(/scan walk failed/);
  });

  it('prunes lost+found from the walk', async () => {
    const { exec, calls } = mockExec({ find: ok('') });
    await scanMount(exec, '/run/servicebay/disk-import/sda1');
    const argv = calls[0];
    expect(argv).toContain('lost+found');
    expect(argv).toContain('-prune');
    // -prune comes before the -type f test (it's the first arm of the -o).
    expect(argv.indexOf('-prune')).toBeLessThan(argv.lastIndexOf('-type'));
  });

  it('prunes node_modules/.git and every junk subtree segment (#1932)', async () => {
    const { exec, calls } = mockExec({ find: ok('') });
    await scanMount(exec, '/run/servicebay/disk-import/sda1');
    const argv = calls[0];
    // Each junk segment is pruned (single-sourced from JUNK_PATH_SEGMENTS), so
    // node_modules/.git etc. are never descended → never enumerated or hashed.
    expect(argv).toContain('node_modules');
    expect(argv).toContain('.git');
    for (const seg of JUNK_PATH_SEGMENTS) expect(argv).toContain(seg);
    // The prune group precedes the -type f test (it's the first -o arm).
    expect(argv.indexOf('-prune')).toBeLessThan(argv.lastIndexOf('-type'));
  });
});

describe('buildScanFindArgs (#1932)', () => {
  it('wraps the prune names in a \\( … -o … \\) group, pruned before -type f', () => {
    const argv = buildScanFindArgs('/mnt/x');
    expect(argv.slice(0, 2)).toEqual(['find', '/mnt/x']);
    // The pruned dir names live inside a parenthesised -name … -o -name … group.
    const open = argv.indexOf('(');
    const close = argv.indexOf(')');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    const group = argv.slice(open, close + 1);
    expect(group).toContain('lost+found');
    expect(group).toContain('node_modules');
    expect(group).toContain('.git');
    // -name precedes each pruned name; -o separates them.
    expect(group.filter(a => a === '-name').length).toBe(1 + JUNK_PATH_SEGMENTS.length);
    expect(group.filter(a => a === '-o').length).toBe(JUNK_PATH_SEGMENTS.length); // n names → n-1 separators (+ lost+found = n)
    // -prune is applied to the whole group, before the -type f arm.
    expect(argv[close + 1]).toBe('-prune');
    expect(argv.indexOf('-prune')).toBeLessThan(argv.indexOf('-type'));
    // The NUL-delimited printf output contract is unchanged.
    expect(argv).toContain('-printf');
    expect(argv).toContain('%p\t%s\t%T@\\0');
  });

  it('never descends a pruned subtree: scanMount returns exactly what find streams', async () => {
    // The real prune happens in `find` itself; here we assert the contract that
    // scanMount returns exactly what find streams (find having pruned the junk).
    const { exec } = mockExec({ find: ok('/mnt/real/song.flac\t10\t1700000000\0') });
    const files = await scanMount(exec, '/run/servicebay/disk-import/sda1');
    expect(files).toEqual([{ path: '/mnt/real/song.flac', size: 10, mtimeMs: 1700000000000 }]);
  });
});

describe('scanMount — partial-walk tolerance', () => {
  it('tolerates find exit 1 (permission-denied descent) when stdout still parsed', async () => {
    // A real ext4 disk with a root-0700 subdir: find prints what it could read
    // to stdout AND a "Permission denied" line on stderr, then exits 1. We keep
    // the readable listing instead of failing the whole scan (#1893).
    const { exec } = mockExec({
      find: {
        stdout: '/mnt/x/a.jpg\t10\t1700000000\0',
        stderr: "find: '/mnt/x/private': Permission denied",
        code: 1,
      },
    });
    const files = await scanMount(exec, '/run/servicebay/disk-import/sda1');
    expect(files).toEqual([{ path: '/mnt/x/a.jpg', size: 10, mtimeMs: 1700000000000 }]);
  });
});

describe('hashSourceFile', () => {
  it('returns the sha256 token from sha256sum output', async () => {
    const hex = 'a'.repeat(64);
    const { exec, calls } = mockExec({ sha256sum: ok(`${hex}  /mnt/a.jpg\n`) });
    expect(await hashSourceFile(exec, '/mnt/a.jpg')).toBe(hex);
    expect(calls[0]).toEqual(['sha256sum', '/mnt/a.jpg']);
  });

  it('throws on unexpected (non-hex) sha256sum output', async () => {
    const { exec } = mockExec({ sha256sum: ok('not a hash\n') });
    await expect(hashSourceFile(exec, '/mnt/a.jpg')).rejects.toThrow(/unexpected sha256sum/);
  });

  it('throws on a non-zero exit', async () => {
    const { exec } = mockExec({ sha256sum: { stdout: '', stderr: 'no file', code: 1 } });
    await expect(hashSourceFile(exec, '/mnt/a.jpg')).rejects.toThrow(/sha256sum failed/);
  });
});

/** A `sha256sum <p1> <p2> …` mock that hashes each arg path deterministically. */
function batchedSha256(hashOf: (p: string) => string): { exec: SafeExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: SafeExec = vi.fn(async (argv: string[]) => {
    calls.push(argv);
    const lines = argv.slice(1).map(p => `${hashOf(p)}  ${p}`);
    return ok(lines.join('\n') + '\n');
  });
  return { exec, calls };
}

describe('hashRecords', () => {
  it('hashes records in ONE batched sha256sum call and returns a path→hash map', async () => {
    const h1 = '1'.repeat(64);
    const h2 = '2'.repeat(64);
    const { exec, calls } = batchedSha256(p => (p === '/mnt/a' ? h1 : h2));
    const records: ImportRecord[] = [
      { sourcePath: '/mnt/a', size: 1, mtimeMs: 0, ext: '', name: 'a' },
      { sourcePath: '/mnt/b', size: 1, mtimeMs: 0, ext: '', name: 'b' },
    ];
    const map = await hashRecords(exec, records);
    expect(map.get('/mnt/a')).toBe(h1);
    expect(map.get('/mnt/b')).toBe(h2);
    // Both files hashed in a single agent round-trip (not one per file).
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['sha256sum', '/mnt/a', '/mnt/b']);
  });

  it('fires onProgress once per file even within a batched call', async () => {
    const { exec } = batchedSha256(() => 'a'.repeat(64));
    const records: ImportRecord[] = [
      { sourcePath: '/mnt/a', size: 1, mtimeMs: 0, ext: '', name: 'a' },
      { sourcePath: '/mnt/b', size: 1, mtimeMs: 0, ext: '', name: 'b' },
      { sourcePath: '/mnt/c', size: 1, mtimeMs: 0, ext: '', name: 'c' },
    ];
    const ticks: Array<[number, number]> = [];
    await hashRecords(exec, records, (hashed, total) => ticks.push([hashed, total]));
    expect(ticks).toEqual([[1, 3], [2, 3], [3, 3]]);
  });
});

describe('hashPaths — batched execution (#1898)', () => {
  it('drops exec round-trips from N (per-file) to ceil(N / HASH_BATCH_SIZE)', async () => {
    const n = HASH_BATCH_SIZE * 2 + 5; // forces 3 chunks
    const paths = Array.from({ length: n }, (_, i) => `/mnt/f${i}`);
    const { exec, calls } = batchedSha256(() => 'b'.repeat(64));
    const map = await hashPaths(exec, paths);
    expect(map.size).toBe(n);
    // 3 round-trips for 517 files — NOT 517 (the per-file regression #1898).
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c[0] === 'sha256sum')).toBe(true);
  });

  it('returns no round-trip for an empty path list', async () => {
    const { exec, calls } = batchedSha256(() => 'c'.repeat(64));
    expect((await hashPaths(exec, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('decodes sha256sum backslash-escaped lines (path with a newline)', async () => {
    const hex = 'd'.repeat(64);
    // GNU coreutils escapes a path containing a newline: it prefixes the line
    // with `\` and writes `\n` for the embedded newline. We must map it back to
    // the EXACT input path so the hash lands on the right record.
    const exec: SafeExec = vi.fn(async () => ok(`\\${hex}  /mnt/od\\nd\n`));
    const map = await hashPaths(exec, ['/mnt/od\nd']);
    expect(map.get('/mnt/od\nd')).toBe(hex);
  });

  it('throws if sha256sum omits a requested path', async () => {
    const exec: SafeExec = vi.fn(async () => ok(`${'e'.repeat(64)}  /mnt/a\n`));
    await expect(hashPaths(exec, ['/mnt/a', '/mnt/b'])).rejects.toThrow(/no hash for/);
  });

  it('refuses a NUL byte in a path before any host call', async () => {
    const { exec, calls } = batchedSha256(() => 'f'.repeat(64));
    await expect(hashPaths(exec, ['/mnt/\0evil'])).rejects.toThrow(/NUL byte/);
    expect(calls).toHaveLength(0);
  });
});
