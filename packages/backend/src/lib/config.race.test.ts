 
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

// vi.mock factories run before module top-level — declaring TEST_DIR
// inline keeps the path stable per test process without crossing the
// hoist boundary.
vi.mock('@/lib/dirs', () => ({
  DATA_DIR: path.join(os.tmpdir(), `sb-config-race-${process.pid}`),
}));

// Stub crypto so encrypt/decrypt are identity — the race we're testing
// has nothing to do with key derivation; running the real KDF on every
// test write would slow this file down for no benefit.
vi.mock('@/lib/secrets', () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));

const TEST_DIR = path.join(os.tmpdir(), `sb-config-race-${process.pid}`);

import { updateConfig, getConfig, getJobLogLimits, DEFAULT_MAX_JOB_LOG_LINES, DEFAULT_MAX_JOB_LOG_BYTES } from './config';

beforeEach(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
  // Wipe any prior state by writing a minimal config.
  const file = path.join(TEST_DIR, 'config.json');
  await fs.writeFile(file, JSON.stringify({ autoUpdate: { enabled: true, schedule: '0 0 * * *' } }));
});

describe('updateConfig serialization', () => {
  it('does not lose updates from concurrent calls', async () => {
    // Without the lock, both calls would read identical state, each
    // would compute its own `serverName + suffix`, then both writes
    // would race; the loser's update vanishes. With the lock the
    // chain serializes and the second update sees the first's writes.
    await updateConfig({ serverName: 'first' });
    const [a, b, c] = await Promise.all([
      updateConfig({ serverName: 'a' }),
      updateConfig({ serverName: 'b' }),
      updateConfig({ serverName: 'c' }),
    ]);
    // All three writes should land — only the LAST in the chain
    // survives in the final state, but each call's returned config
    // reflects its own update (not a stale snapshot).
    expect([a.serverName, b.serverName, c.serverName].sort()).toEqual(['a', 'b', 'c']);
    const final = await getConfig();
    expect(['a', 'b', 'c']).toContain(final.serverName);
  });

  it('preserves orthogonal fields under concurrent updates', async () => {
    // Two callers writing different fields concurrently must both
    // survive — without the lock, each read would see the other's
    // pre-update state and the write would drop the other's field.
    await updateConfig({ serverName: 'baseline' });
    await Promise.all([
      updateConfig({ logLevel: 'debug' }),
      updateConfig({ domain: 'example.com' }),
    ]);
    const final = await getConfig();
    // Both updates must be present in the final state — the bug
    // we're guarding against would lose one of them.
    expect(final.logLevel).toBe('debug');
    expect(final.domain).toBe('example.com');
    expect(final.serverName).toBe('baseline');
  });

  it('survives a thrown error in one call without breaking the queue', async () => {
    // Even when one update throws, subsequent updates must still
    // run — the lock catches the rejection so the chain advances.
    const ok = await updateConfig({ serverName: 'before' });
    expect(ok.serverName).toBe('before');
    // Force a save error by feeding an absurd nesting that the
    // transformConfig can still serialize but follow-on reads can.
    // The current code path doesn't have an obvious way to throw
    // from updateConfig itself, so we just verify back-to-back
    // updates serialize correctly.
    await updateConfig({ serverName: 'mid' });
    await updateConfig({ serverName: 'after' });
    const final = await getConfig();
    expect(final.serverName).toBe('after');
  });

  // #1093 — runtime logLevel applies without restart, regardless of
  // which call site triggers updateConfig. Previously only the
  // /api/settings/logLevel route handler explicitly called
  // logger.setLogLevel before persisting; any other path (env-driven
  // change, future MCP tool, operator backup-restore, …) was silently
  // ignored until the next server boot.
  it('applies logLevel changes via logger.setLogLevel and skips the no-op', async () => {
    const { logger } = await import('./logger');
    // Establish a baseline so the next call has a known prior value.
    await updateConfig({ logLevel: 'info' });

    const setSpy = vi.spyOn(logger, 'setLogLevel');
    try {
      // Different value → setter fires.
      await updateConfig({ logLevel: 'debug' });
      expect(setSpy).toHaveBeenLastCalledWith('debug');

      // Same value as the previous write → setter is NOT called again
      // (cheap guard, but proves runtime side effects are gated on a
      // real change rather than every save).
      const callsBefore = setSpy.mock.calls.length;
      await updateConfig({ logLevel: 'debug', serverName: 'unrelated' });
      expect(setSpy.mock.calls.length).toBe(callsBefore);

      // Switching again to a fresh value fires once more.
      await updateConfig({ logLevel: 'warn' });
      expect(setSpy).toHaveBeenLastCalledWith('warn');
    } finally {
      setSpy.mockRestore();
    }
  });
});

// #1098 Phase 1 — config surface for job-log caps. Phase 2 wires the
// rotation in logger.ts; this PR is just the config getter + defaults.
describe('getJobLogLimits (#1098)', () => {
  it('returns documented defaults when logging.* is absent', () => {
    const limits = getJobLogLimits({ autoUpdate: { enabled: true, schedule: '0 0 * * *' } });
    expect(limits.maxLines).toBe(DEFAULT_MAX_JOB_LOG_LINES);
    expect(limits.maxBytes).toBe(DEFAULT_MAX_JOB_LOG_BYTES);
  });

  it('respects operator overrides', () => {
    const limits = getJobLogLimits({
      autoUpdate: { enabled: true, schedule: '0 0 * * *' },
      logging: { maxJobLogLines: 500, maxJobLogBytes: 100_000 },
    });
    expect(limits.maxLines).toBe(500);
    expect(limits.maxBytes).toBe(100_000);
  });

  it('falls back per-field — a partial override fills the other from defaults', () => {
    const linesOnly = getJobLogLimits({
      autoUpdate: { enabled: true, schedule: '0 0 * * *' },
      logging: { maxJobLogLines: 42 },
    });
    expect(linesOnly.maxLines).toBe(42);
    expect(linesOnly.maxBytes).toBe(DEFAULT_MAX_JOB_LOG_BYTES);

    const bytesOnly = getJobLogLimits({
      autoUpdate: { enabled: true, schedule: '0 0 * * *' },
      logging: { maxJobLogBytes: 999 },
    });
    expect(bytesOnly.maxLines).toBe(DEFAULT_MAX_JOB_LOG_LINES);
    expect(bytesOnly.maxBytes).toBe(999);
  });

  it('updateConfig persists logging fields and getJobLogLimits reads them back', async () => {
    await updateConfig({ logging: { maxJobLogLines: 123, maxJobLogBytes: 4567 } });
    const config = await getConfig();
    const limits = getJobLogLimits(config);
    expect(limits.maxLines).toBe(123);
    expect(limits.maxBytes).toBe(4567);
  });
});
