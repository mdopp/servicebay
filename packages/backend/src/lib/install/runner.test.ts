/**
 * Install-runner unit tests (#810).
 *
 * Covers the inter-template readiness gate: `isServiceReady` (the
 * readiness predicate) and `waitForDependencies` (the gate that blocks
 * a template's deploy until its declared dependencies are healthy).
 *
 * The twin is mocked the same way `stackRunner.test.ts` does it, so the
 * gate reads deterministic fixtures instead of a live digital twin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const twinStub: {
  nodes: Record<string, { services?: Array<{ name: string; active?: boolean; health?: { ready: boolean } }> }>;
} = { nodes: {} };
vi.mock('@/lib/store/twin', () => ({
  DigitalTwinStore: {
    getInstance: () => ({
      getSnapshot: () => ({ nodes: twinStub.nodes }),
    }),
  },
}));

// The gate registers deployed services with the health poller before
// polling. In a unit test there is no agent to list services from, so
// stub the bootstrap to a no-op.
const bootstrapMock = vi.fn().mockResolvedValue({ registered: [], skipped: [] });
vi.mock('@/lib/health/serviceHealthBootstrap', () => ({
  bootstrapServiceHealth: () => bootstrapMock(),
}));

import { isServiceReady, waitForDependencies } from './runner';

beforeEach(() => {
  twinStub.nodes = {};
  bootstrapMock.mockClear();
});

describe('isServiceReady', () => {
  it('prefers the health signal over systemd-active', () => {
    // active=true but health.ready=false → not ready (app still booting
    // inside an active unit — the exact #810 failure mode).
    expect(isServiceReady([{ name: 'auth', active: true, health: { ready: false } }], 'auth')).toBe(false);
    expect(isServiceReady([{ name: 'auth', active: false, health: { ready: true } }], 'auth')).toBe(true);
  });

  it('falls back to systemd-active when no health signal is present', () => {
    expect(isServiceReady([{ name: 'nginx', active: true }], 'nginx')).toBe(true);
    expect(isServiceReady([{ name: 'nginx', active: false }], 'nginx')).toBe(false);
  });

  it('matches a unit name with or without the .service suffix', () => {
    expect(isServiceReady([{ name: 'auth.service', active: true }], 'auth')).toBe(true);
  });

  it('returns false when the service is absent from the twin', () => {
    expect(isServiceReady([{ name: 'nginx', active: true }], 'auth')).toBe(false);
  });
});

describe('waitForDependencies', () => {
  it('returns immediately when the item declares no dependencies', async () => {
    await waitForDependencies('job1', { name: 'ollama', dependencies: [] }, 'Local');
    // No twin read, no health bootstrap when there is nothing to gate on.
    expect(bootstrapMock).not.toHaveBeenCalled();
  });

  it('resolves once every declared dependency is healthy', async () => {
    twinStub.nodes['Local'] = {
      services: [
        { name: 'nginx', health: { ready: true } },
        { name: 'auth', health: { ready: true } },
      ],
    };
    await expect(
      waitForDependencies('job1', { name: 'media', dependencies: ['nginx', 'auth'] }, 'Local'),
    ).resolves.toBeUndefined();
    // The gate registers deployed services with the health poller first.
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
  });
});
