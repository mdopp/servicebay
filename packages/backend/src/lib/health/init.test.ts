import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CheckConfig } from './types';

// Per-service health checks are gated on actual deployment (#1506):
// initializeDefaultChecks reconciles the on-disk checks to the set of
// deployed services (ServiceManager.listServices, which reads the deployed
// Quadlet files). A service that isn't deployed must lose its check.

const { state } = vi.hoisted(() => ({
  state: { checks: [] as CheckConfig[], deployed: [] as string[] },
}));

vi.mock('./store', () => ({
  HealthStore: {
    getChecks: () => [...state.checks],
    saveCheck: (c: CheckConfig) => {
      const i = state.checks.findIndex(x => x.id === c.id);
      if (i >= 0) state.checks[i] = c; else state.checks.push(c);
    },
    deleteCheck: (id: string) => { state.checks = state.checks.filter(c => c.id !== id); },
    deleteServiceCheck: (target: string) => {
      const before = state.checks.length;
      state.checks = state.checks.filter(c =>
        !((c.type === 'service' && c.target === target) || c.name === `Service: ${target}`));
      return before - state.checks.length;
    },
  },
}));
vi.mock('../services/ServiceManager', () => ({
  ServiceManager: { listServices: vi.fn(async () => state.deployed.map(name => ({ name }))) },
}));
vi.mock('../config', () => ({ getConfig: vi.fn(async () => ({ gateway: undefined })) }));
vi.mock('../nodes', () => ({ listNodes: vi.fn(async () => []) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { initializeDefaultChecks } from './init';

const serviceCheck = (target: string): CheckConfig => ({
  id: `id-${target}`, name: `Service: ${target}`, type: 'service', target,
  interval: 60, enabled: true, created_at: new Date().toISOString(),
});

describe('initializeDefaultChecks service-check reconciliation (#1506)', () => {
  beforeEach(() => { state.checks = []; state.deployed = []; });

  it('prunes a per-service check whose target is no longer deployed', async () => {
    state.checks = [serviceCheck('ollama'), serviceCheck('vaultwarden')];
    state.deployed = ['vaultwarden'];

    await initializeDefaultChecks();

    const targets = state.checks.filter(c => c.type === 'service').map(c => c.target);
    expect(targets).toContain('vaultwarden');
    expect(targets).not.toContain('ollama');
  });

  it('keeps the podman.socket singleton even though it is not a deployed stack', async () => {
    state.deployed = [];

    await initializeDefaultChecks();

    expect(state.checks.some(c => c.type === 'service' && c.target === 'podman.socket')).toBe(true);
  });

  it('adds a check for a deployed service that has none', async () => {
    state.deployed = ['immich'];

    await initializeDefaultChecks();

    expect(state.checks.some(c => c.type === 'service' && c.target === 'immich')).toBe(true);
  });
});
