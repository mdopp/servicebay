// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { atomicWriteFile } from '../../src/lib/util/atomicWrite';

const tmpDir = path.join(os.tmpdir(), 'sb-atomic-test');

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('writes the target path with the given content', async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const target = path.join(tmpDir, 'config.json');
    await atomicWriteFile(target, '{"a":1}');
    expect(await fs.readFile(target, 'utf-8')).toBe('{"a":1}');
  });

  it('overwrites existing content atomically', async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const target = path.join(tmpDir, 'data.json');
    await fs.writeFile(target, 'OLD');
    await atomicWriteFile(target, 'NEW');
    expect(await fs.readFile(target, 'utf-8')).toBe('NEW');
  });

  it('does not leave temp files behind on success', async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const target = path.join(tmpDir, 'file.txt');
    await atomicWriteFile(target, 'hello');
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter(e => e.endsWith('.tmp'))).toEqual([]);
  });

  it('cleans up temp files on rename failure', async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    // rename to a directory path that exists as a file should fail
    const target = path.join(tmpDir, 'will-conflict');
    await fs.mkdir(target);
    await expect(atomicWriteFile(target, 'x')).rejects.toThrow();
    const entries = await fs.readdir(tmpDir);
    expect(entries.filter(e => e.endsWith('.tmp'))).toEqual([]);
  });
});
