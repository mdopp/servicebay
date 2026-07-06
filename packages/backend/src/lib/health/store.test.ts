import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import type { CheckConfig, CheckResult } from './types';

// Point DATA_DIR at a fresh temp dir BEFORE importing the store (dirs.ts
// reads process.env.DATA_DIR at module load).
let tmpDir: string;

const serviceCheck = (target: string): CheckConfig => ({
  id: `id-${target}`,
  name: `Service: ${target}`,
  type: 'service',
  target,
  interval: 60,
  enabled: true,
  created_at: new Date().toISOString(),
});

describe('HealthStore.deleteServiceCheck (#1506)', () => {
  let HealthStore: typeof import('./store').HealthStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'healthstore-'));
    vi.resetModules();
    process.env.DATA_DIR = tmpDir;
    ({ HealthStore } = await import('./store'));
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('removes the per-service check matching target and reports the count', () => {
    HealthStore.saveCheck(serviceCheck('ollama'));
    HealthStore.saveCheck(serviceCheck('vaultwarden'));

    const removed = HealthStore.deleteServiceCheck('ollama');

    expect(removed).toBe(1);
    const remaining = HealthStore.getChecks().map(c => c.target);
    expect(remaining).toEqual(['vaultwarden']);
  });

  it('matches the legacy "Service: <name>" naming even without a service target', () => {
    HealthStore.saveCheck({
      ...serviceCheck('hermes'),
      type: 'http',
      target: 'http://localhost:81',
      name: 'Service: hermes',
    });

    const removed = HealthStore.deleteServiceCheck('hermes');

    expect(removed).toBe(1);
    expect(HealthStore.getChecks()).toHaveLength(0);
  });

  it('does not touch unrelated checks and returns 0 when nothing matches', () => {
    HealthStore.saveCheck(serviceCheck('immich'));
    const pingCheck: CheckConfig = {
      id: 'gw', name: 'Internet Gateway', type: 'ping', target: '192.168.178.1',
      interval: 60, enabled: true, created_at: new Date().toISOString(),
    };
    HealthStore.saveCheck(pingCheck);

    const removed = HealthStore.deleteServiceCheck('not-installed');

    expect(removed).toBe(0);
    expect(HealthStore.getChecks().map(c => c.target).sort()).toEqual(['192.168.178.1', 'immich']);
  });
});

describe('HealthStore.markLastResultAlerted (#1661)', () => {
  let HealthStore: typeof import('./store').HealthStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'healthstore-'));
    vi.resetModules();
    process.env.DATA_DIR = tmpDir;
    ({ HealthStore } = await import('./store'));
  });

  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Use recent timestamps — saveResult drops anything older than the 7-day
  // retention window, so a fixed past date would be filtered out on save.
  const result = (status: 'ok' | 'fail', secondsAgo: number): CheckResult => ({
    check_id: 'c1', status, timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  });

  it('flags the most-recent result and leaves older ones untouched', () => {
    HealthStore.saveResult(result('fail', 2)); // older
    HealthStore.saveResult(result('fail', 1)); // newest-first: [1, 2]

    HealthStore.markLastResultAlerted('c1');

    const results = HealthStore.getResults('c1');
    expect(results[0].alerted).toBe(true);
    expect(results[1].alerted).toBeUndefined();
  });

  it('is a no-op when the check has no persisted result', () => {
    expect(() => HealthStore.markLastResultAlerted('never-run')).not.toThrow();
    expect(HealthStore.getResults('never-run')).toEqual([]);
  });
});

describe('HealthStore read cache (#2163) — no synchronous re-read on the hot path', () => {
  let HealthStore: typeof import('./store').HealthStore;
  let realFs: typeof import('fs');

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'healthstore-'));
    vi.resetModules();
    vi.restoreAllMocks();
    process.env.DATA_DIR = tmpDir;
    realFs = (await import('fs')).default;
    ({ HealthStore } = await import('./store'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const result = (secondsAgo: number): CheckResult => ({
    check_id: 'perf', status: 'ok',
    timestamp: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  });

  it('getChecks() serves from cache without a second readFileSync when the file is unchanged', () => {
    HealthStore.saveCheck(serviceCheck('immich'));
    // Prime the cache.
    expect(HealthStore.getChecks().map(c => c.target)).toEqual(['immich']);

    const readSpy = vi.spyOn(realFs, 'readFileSync');
    // Many hot-path reads with no intervening write → zero disk parses.
    for (let i = 0; i < 20; i++) HealthStore.getChecks();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('getResults() serves from cache without a second readFileSync when the file is unchanged', () => {
    HealthStore.saveResult(result(1));
    // Prime the cache.
    expect(HealthStore.getResults('perf')).toHaveLength(1);

    const readSpy = vi.spyOn(realFs, 'readFileSync');
    for (let i = 0; i < 20; i++) HealthStore.getResults('perf');
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('a write invalidates the cache so the next read reflects it (no stale serve)', () => {
    HealthStore.saveCheck(serviceCheck('immich'));
    expect(HealthStore.getChecks().map(c => c.target)).toEqual(['immich']);

    HealthStore.saveCheck(serviceCheck('vaultwarden'));
    // Read-after-write must see the new check, not the cached snapshot.
    expect(HealthStore.getChecks().map(c => c.target).sort()).toEqual(['immich', 'vaultwarden']);
  });

  it('picks up an external write (mtime/size change) even without going through the store', () => {
    HealthStore.saveCheck(serviceCheck('immich'));
    expect(HealthStore.getChecks()).toHaveLength(1);

    // Simulate another bundle/process rewriting checks.json directly.
    realFs.writeFileSync(
      path.join(tmpDir, 'checks.json'),
      JSON.stringify([serviceCheck('immich'), serviceCheck('media')], null, 2),
    );
    expect(HealthStore.getChecks().map(c => c.target).sort()).toEqual(['immich', 'media']);
  });
});

describe('HealthStore.deleteCheck — honest return (synthetic rows can\'t be deleted)', () => {
  let HealthStore: typeof import('./store').HealthStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'healthstore-'));
    vi.resetModules();
    process.env.DATA_DIR = tmpDir;
    ({ HealthStore } = await import('./store'));
  });
  afterEach(async () => {
    delete process.env.DATA_DIR;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns true when a stored check is actually removed', () => {
    HealthStore.saveCheck(serviceCheck('immich'));
    expect(HealthStore.deleteCheck('id-immich')).toBe(true);
    expect(HealthStore.getChecks()).toHaveLength(0);
  });

  it('returns false (no fake success) for an id that is not stored — e.g. a synthetic diagnose row', () => {
    HealthStore.saveCheck(serviceCheck('immich'));
    expect(HealthStore.deleteCheck('diagnose:sso_verify')).toBe(false);
    // the stored check is untouched — nothing was silently rewritten.
    expect(HealthStore.getChecks().map(c => c.target)).toEqual(['immich']);
  });
});
