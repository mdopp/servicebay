 
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckConfig, CheckResult } from '@/lib/health/types';

const state = {
  checks: [] as CheckConfig[],
  results: new Map<string, CheckResult>(),
  // Each call to CheckRunner.run returns the next outcome from the
  // queue. Lets a single test seed mixed pass/fail outcomes.
  runOutcomes: [] as Array<'ok' | 'fail' | 'throw'>,
  runCallCount: 0,
};

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getChecks: () => state.checks,
    getLastResult: (id: string) => state.results.get(id) ?? null,
    saveResult: (r: CheckResult) => state.results.set(r.check_id, r),
  },
}));

vi.mock('@/lib/health/runner', () => ({
  CheckRunner: {
    run: vi.fn((check: CheckConfig) => {
      state.runCallCount++;
      const outcome = state.runOutcomes.shift() ?? 'ok';
      if (outcome === 'throw') return Promise.reject(new Error('runner exploded'));
      const result: CheckResult = {
        check_id: check.id,
        timestamp: new Date().toISOString(),
        status: outcome,
        latency: 1,
      };
      state.results.set(check.id, result);
      return Promise.resolve(result);
    }),
  },
}));

import { dispatchProbeAction } from '../actions';
import './healthChecks';

const oldCheck = (id: string): CheckConfig => ({
  id,
  name: id,
  type: 'http',
  target: 'http://x',
  interval: 60,
  enabled: true,
  // 5 min ago — past the 2 min "stale" grace.
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
});

beforeEach(() => {
  state.checks = [];
  state.results = new Map();
  state.runOutcomes = [];
  state.runCallCount = 0;
});

describe('health_checks probe action: run_all_stale', () => {
  it('reports "all passed" when every stale check returns status:ok', async () => {
    // Three enabled, stale checks (no result yet, created > 2 min ago).
    state.checks = [oldCheck('a'), oldCheck('b'), oldCheck('c')];
    state.runOutcomes = ['ok', 'ok', 'ok'];

    const r = await dispatchProbeAction({
      probeId: 'health_checks',
      actionId: 'run_all_stale',
      node: 'Local',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/all passed/);
    expect(state.runCallCount).toBe(3);
  });

  it('counts mixed pass/fail outcomes accurately (regression: "pass" → "ok" rename)', async () => {
    state.checks = [oldCheck('a'), oldCheck('b'), oldCheck('c'), oldCheck('d')];
    state.runOutcomes = ['ok', 'fail', 'ok', 'fail'];

    const r = await dispatchProbeAction({
      probeId: 'health_checks',
      actionId: 'run_all_stale',
      node: 'Local',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/2 passed, 2 failed/);
  });

  it('counts a thrown runner as a failure', async () => {
    state.checks = [oldCheck('a'), oldCheck('b')];
    state.runOutcomes = ['ok', 'throw'];

    const r = await dispatchProbeAction({
      probeId: 'health_checks',
      actionId: 'run_all_stale',
      node: 'Local',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/1 passed, 1 failed/);
  });

  it('returns an informational message when no stale checks remain', async () => {
    // Check exists but already has a result → not stale.
    state.checks = [oldCheck('a')];
    state.results.set('a', { check_id: 'a', timestamp: new Date().toISOString(), status: 'ok', latency: 1 });

    const r = await dispatchProbeAction({
      probeId: 'health_checks',
      actionId: 'run_all_stale',
      node: 'Local',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/No stale checks/);
    expect(state.runCallCount).toBe(0);
  });
});
