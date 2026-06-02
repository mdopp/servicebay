/**
 * Phase 3b (#484): `checkNpmDataStale` is now a thin HealthStore reader.
 * Detection logic moved into `CheckRunner.runNpmAuthCheck` — these
 * tests cover the reader-side contract only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckResult } from '@/lib/health/types';

const state = {
  results: new Map<string, CheckResult>(),
  checks: [{ id: 'npm_auth' }] as Array<{ id: string }>,
};

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getLastResult: (id: string) => state.results.get(id) ?? null,
    getChecks: () => state.checks,
  },
}));

import { checkNpmDataStale } from './npmDataStale';

beforeEach(() => {
  state.results = new Map();
  state.checks = [{ id: 'npm_auth' }];
});

describe('checkNpmDataStale (reader)', () => {
  it('returns info when HealthStore has no result yet (check exists, just pending first run)', async () => {
    const out = await checkNpmDataStale();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/first run pending/);
  });

  it('reports the missing-prereq state when the npm_auth check has not been created yet (#664)', async () => {
    state.checks = [];
    const out = await checkNpmDataStale();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/NPM admin bootstrap/);
  });

  it('decodes a stale-credentials fail payload', async () => {
    const payload = {
      status: 'fail',
      detail: 'Nginx Proxy Manager is rejecting the stored admin credentials.',
      hint: 'If you know the password NPM is actually using, click "Use existing password".',
    };
    state.results.set('npm_auth', {
      check_id: 'npm_auth',
      timestamp: new Date().toISOString(),
      status: 'fail',
      payload,
      latency: 100,
    });
    const out = await checkNpmDataStale();
    expect(out.status).toBe('fail');
    expect(out.detail).toBe(payload.detail);
    expect(out.hint).toBe(payload.hint);
  });

  it('decodes an ok payload', async () => {
    const payload = { status: 'ok', detail: 'NPM accepts the stored admin credentials.' };
    state.results.set('npm_auth', {
      check_id: 'npm_auth',
      timestamp: new Date().toISOString(),
      status: 'ok',
      payload,
      latency: 100,
    });
    const out = await checkNpmDataStale();
    expect(out.status).toBe('ok');
    expect(out.detail).toBe(payload.detail);
  });

  it('surfaces transport-error plaintext as info', async () => {
    state.results.set('npm_auth', {
      check_id: 'npm_auth',
      timestamp: new Date().toISOString(),
      status: 'fail',
      message: 'npm_auth error: ServiceManager exploded',
      latency: 100,
    });
    const out = await checkNpmDataStale();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/Check failed to run.*ServiceManager exploded/);
  });
});
