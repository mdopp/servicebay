import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SCRIPT_CHECK_RETIRED_SUFFIX, type CheckConfig } from './types';

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

const httpCheck = (id: string): CheckConfig => ({
  id, name: id, type: 'http', target: 'http://localhost/',
  interval: 60, enabled: true, created_at: new Date().toISOString(),
});

describe('initializeDefaultChecks template-registered check prune (#1551)', () => {
  beforeEach(() => { state.checks = []; state.deployed = []; });

  it('prunes a template-registered http check whose owning service is not deployed', async () => {
    state.checks = [httpCheck('ollama-api'), httpCheck('home-assistant-api')];
    state.deployed = ['home-assistant'];

    await initializeDefaultChecks();

    const ids = state.checks.map(c => c.id);
    expect(ids).not.toContain('ollama-api');     // owner not deployed → pruned
    expect(ids).toContain('home-assistant-api'); // owner deployed → kept
  });

  it('keeps a manually-added http check (uuid id), even when nothing is deployed', async () => {
    const manual = httpCheck('a1b2c3d4-e5f6-4789-8abc-1234567890ab');
    manual.name = 'Link: my router';
    state.checks = [manual];
    state.deployed = [];

    await initializeDefaultChecks();

    expect(state.checks.map(c => c.id)).toContain('a1b2c3d4-e5f6-4789-8abc-1234567890ab');
  });
});

describe('initializeDefaultChecks retires a stored script check (#2535)', () => {
  // `type: "script"` was removed: the probe evaluated the check's target with
  // `vm.runInContext` inside the backend process. This box has none, but another
  // box may — and both silent outcomes are unacceptable. Deleting the row would
  // throw away the operator's only copy of what they were monitoring (the JS
  // lives in `target`, and nothing can be auto-derived from arbitrary JS), and
  // leaving it enabled would tick forever as "unknown check type". So it is
  // disabled in place, with the reason on the name.
  const scriptCheck = (over: Partial<CheckConfig> = {}): CheckConfig => ({
    id: 'b7c1e2d3-4444-4555-8666-777788889999',
    name: 'Ollama model loaded',
    // `script` is no longer a CheckType — this is a row that predates the removal.
    type: 'script' as unknown as CheckConfig['type'],
    target: 'const r = await fetch("http://127.0.0.1:11434/api/tags"); if (!r.ok) throw new Error("down")',
    interval: 60,
    enabled: true,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  beforeEach(() => { state.checks = []; state.deployed = []; });

  it('disables it instead of deleting it, and keeps the target verbatim', async () => {
    const original = scriptCheck();
    state.checks = [original];

    await initializeDefaultChecks();

    const retired = state.checks.find(c => c.id === original.id);
    expect(retired, 'the row must survive — deleting it loses the operator\'s script').toBeDefined();
    expect(retired!.enabled).toBe(false);
    expect(retired!.target).toBe(original.target);
    expect(retired!.interval).toBe(original.interval);
    expect(retired!.created_at).toBe(original.created_at);
  });

  it('appends a visible reason to the name so the operator sees WHY it stopped', async () => {
    state.checks = [scriptCheck()];

    await initializeDefaultChecks();

    const retired = state.checks[0];
    expect(retired.name).toBe(`Ollama model loaded${SCRIPT_CHECK_RETIRED_SUFFIX}`);
  });

  it('is idempotent — a second boot does not re-append the marker', async () => {
    state.checks = [scriptCheck()];

    await initializeDefaultChecks();
    const afterFirst = state.checks[0].name;
    await initializeDefaultChecks();

    expect(state.checks[0].name).toBe(afterFirst);
    expect(state.checks.filter(c => c.id === 'b7c1e2d3-4444-4555-8666-777788889999')).toHaveLength(1);
  });

  it('re-disables a row an operator manually switched back on', async () => {
    // The type has no probe any more, so "enabled" is never a state it can be
    // left in — re-enabling it would only produce a permanently-failing row.
    state.checks = [scriptCheck({ name: `Ollama model loaded${SCRIPT_CHECK_RETIRED_SUFFIX}`, enabled: true })];

    await initializeDefaultChecks();

    expect(state.checks[0].enabled).toBe(false);
    expect(state.checks[0].name).toBe(`Ollama model loaded${SCRIPT_CHECK_RETIRED_SUFFIX}`);
  });

  it('leaves checks of every surviving type alone', async () => {
    state.checks = [httpCheck('a1b2c3d4-e5f6-4789-8abc-1234567890ab'), scriptCheck()];
    state.deployed = [];

    await initializeDefaultChecks();

    const http = state.checks.find(c => c.id === 'a1b2c3d4-e5f6-4789-8abc-1234567890ab');
    expect(http!.enabled).toBe(true);
    expect(http!.name).toBe('a1b2c3d4-e5f6-4789-8abc-1234567890ab');
  });
});
