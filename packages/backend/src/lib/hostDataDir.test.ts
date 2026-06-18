import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { resolveHostDataDir } from './hostDataDir';
import type { SafeExec } from '@servicebay/disk-import-worker';

// dirs.ts reads HOST_DATA_DIR/DATA_DIR at import time; the default fallback used
// by case (c) is whatever HOST_DATA_DIR resolved to then. In the test env neither
// env var is set, so HOST_DATA_DIR === DATA_DIR === '/app/data'. We assert the
// fall-through returns that imported default (not a hardcoded literal).
import { HOST_DATA_DIR } from './dirs';

/** A SafeExec returning a canned result for the inspect call. */
function inspectExec(result: { stdout?: string; code?: number } | (() => never)) {
  const calls: string[][] = [];
  const exec: SafeExec = vi.fn(async (argv: string[]) => {
    calls.push(argv);
    if (typeof result === 'function') return result();
    return { stdout: result.stdout ?? '', stderr: '', code: result.code ?? 0 };
  });
  return { exec, calls };
}

/** A podman inspect (array form) with a /app/data mount whose host Source is `src`. */
function inspectJson(src: string | null): string {
  return JSON.stringify([
    {
      Name: 'servicebay',
      Mounts: [
        { Type: 'bind', Source: '/run/...sock', Destination: '/run/podman/podman.sock' },
        ...(src ? [{ Type: 'bind', Source: src, Destination: '/app/data' }] : []),
      ],
    },
  ]);
}

const ORIG_ENV = process.env.HOST_DATA_DIR;
beforeEach(() => {
  delete process.env.HOST_DATA_DIR;
});
afterEach(() => {
  if (ORIG_ENV === undefined) delete process.env.HOST_DATA_DIR;
  else process.env.HOST_DATA_DIR = ORIG_ENV;
  vi.restoreAllMocks();
});

describe('resolveHostDataDir', () => {
  it('(a) returns HOST_DATA_DIR env when set & non-empty, without inspecting', async () => {
    process.env.HOST_DATA_DIR = '/mnt/data/servicebay';
    const { exec, calls } = inspectExec({ stdout: inspectJson('/should/not/be/used') });
    expect(await resolveHostDataDir(exec)).toBe('/mnt/data/servicebay');
    expect(calls).toHaveLength(0);
  });

  it('(a) ignores a whitespace-only env and falls through to inspect', async () => {
    process.env.HOST_DATA_DIR = '   ';
    const { exec } = inspectExec({ stdout: inspectJson('/mnt/data/servicebay') });
    expect(await resolveHostDataDir(exec)).toBe('/mnt/data/servicebay');
  });

  it('(b) inspects servicebay and returns the /app/data mount Source', async () => {
    const { exec, calls } = inspectExec({ stdout: inspectJson('/mnt/data/servicebay') });
    expect(await resolveHostDataDir(exec)).toBe('/mnt/data/servicebay');
    // It inspected the servicebay container.
    expect(calls[0]).toEqual(['podman', 'container', 'inspect', 'servicebay', '--format', 'json']);
  });

  it('(b) tolerates a bare-object inspect payload (non-array)', async () => {
    const bare = JSON.stringify({
      Mounts: [{ Source: '/mnt/data/servicebay', Destination: '/app/data' }],
    });
    const { exec } = inspectExec({ stdout: bare });
    expect(await resolveHostDataDir(exec)).toBe('/mnt/data/servicebay');
  });

  it('(c) falls back to the default when inspect has no /app/data mount', async () => {
    const { exec } = inspectExec({ stdout: inspectJson(null) });
    expect(await resolveHostDataDir(exec)).toBe(HOST_DATA_DIR);
  });

  it('(c) falls back to the default when inspect exits non-zero', async () => {
    const { exec } = inspectExec({ stdout: '', code: 125 });
    expect(await resolveHostDataDir(exec)).toBe(HOST_DATA_DIR);
  });

  it('(c) falls back to the default on malformed JSON', async () => {
    const { exec } = inspectExec({ stdout: 'not json{' });
    expect(await resolveHostDataDir(exec)).toBe(HOST_DATA_DIR);
  });

  it('(c) falls back to the default when inspect throws (no socket)', async () => {
    const { exec } = inspectExec(() => {
      throw new Error('connection refused');
    });
    expect(await resolveHostDataDir(exec)).toBe(HOST_DATA_DIR);
  });
});
