/**
 * Registry sync self-heal (#1796).
 *
 * When `git reset --hard` can't unlink the working tree (root-owned files
 * written into the bind mount by another container; SB runs non-root),
 * syncRegistries must rename the broken tree aside and re-clone fresh instead
 * of leaving the registry permanently stale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  access: vi.fn().mockResolvedValue(undefined), // `.git` exists → update path
  rename: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')), // no servicebay.json manifest
}));
vi.mock('fs/promises', () => ({ default: fsMock }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    exec: vi.fn((cmd: string, opts: unknown, cb?: (e: Error | null, r?: unknown) => void) => {
      const done = (typeof opts === 'function' ? opts : cb) as (e: Error | null, r?: unknown) => void;
      // The root-owned working tree fails the hard reset; fetch succeeds.
      if (String(cmd).includes('reset --hard')) {
        done(new Error('error: unable to unlink old solilos-chat/x.py: Permission denied'));
      } else {
        done(null, { stdout: '', stderr: '' });
      }
    }),
    execFile: vi.fn((_file: string, _args: string[], opts: unknown, cb?: (e: Error | null, r?: unknown) => void) => {
      const done = (typeof opts === 'function' ? opts : cb) as (e: Error | null, r?: unknown) => void;
      done(null, { stdout: '', stderr: '' });
    }),
  };
});

vi.mock('./config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config')>()),
  getConfig: vi.fn().mockResolvedValue({
    registries: [{ name: 'oscar', url: 'https://example.invalid/oscar.git' }],
  }),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncRegistries } from './registry';

describe('syncRegistries #1796 self-heal', () => {
  beforeEach(() => fsMock.rename.mockClear());

  it('renames the broken tree aside (then re-clones) when the hard reset fails on a root-owned tree', async () => {
    await syncRegistries();

    // The reset failure self-heals by renaming the broken tree aside instead of
    // being swallowed (which left the registry permanently stale, #1796).
    expect(fsMock.rename).toHaveBeenCalled();
    const renameArgs = fsMock.rename.mock.calls[0] as [string, string];
    expect(renameArgs[0]).not.toMatch(/\.broken-/); // the live tree…
    expect(renameArgs[1]).toMatch(/\.broken-\d+$/); // …moved aside, so the re-clone has a clean path
  });
});

describe('syncRegistries #1836 refresh reaches remote HEAD', () => {
  // A shallow `git fetch --depth 1 origin <branch>` (bare branch name) only
  // advances FETCH_HEAD — it does NOT update the remote-tracking ref
  // `origin/<branch>`, which stays pinned at the clone-time SHA. Resetting to
  // `origin/<branch>` therefore stranded the checkout at the stale revision
  // (box at d556247 while remote HEAD was 1fa1717). The update path must reset
  // to FETCH_HEAD so a single refresh always reaches the freshly-fetched HEAD.
  // (The fetch+reset commands run in a real subprocess that the unit-test mock
  // can't observe, so this asserts the resolved command on the source.)
  it('hard-resets to FETCH_HEAD, not to the stale origin/<branch> ref', () => {
    const src = readFileSync(join(__dirname, 'registry.ts'), 'utf8');
    expect(src).toContain('git reset --hard FETCH_HEAD');
    expect(src).not.toMatch(/git reset --hard origin\/\$\{branch\}/);
  });
});
