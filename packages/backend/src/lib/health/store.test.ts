import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import type { CheckConfig } from './types';

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
