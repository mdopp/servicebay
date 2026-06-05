import { describe, it, expect, vi } from 'vitest';
import { parseFindOutput, scanMount, hashSourceFile, hashRecords } from './hostScan';
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

describe('hashRecords', () => {
  it('hashes each record host-side and returns a path→hash map', async () => {
    const h1 = '1'.repeat(64);
    const h2 = '2'.repeat(64);
    const exec: SafeExec = vi.fn(async (argv: string[]) => {
      const path = argv[1];
      const hex = path === '/mnt/a' ? h1 : h2;
      return ok(`${hex}  ${path}\n`);
    });
    const records: ImportRecord[] = [
      { sourcePath: '/mnt/a', size: 1, mtimeMs: 0, ext: '', name: 'a' },
      { sourcePath: '/mnt/b', size: 1, mtimeMs: 0, ext: '', name: 'b' },
    ];
    const map = await hashRecords(exec, records);
    expect(map.get('/mnt/a')).toBe(h1);
    expect(map.get('/mnt/b')).toBe(h2);
  });
});
