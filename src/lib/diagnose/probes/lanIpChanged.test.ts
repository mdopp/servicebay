/**
 * Phase 3b (#484): `checkLanIpChanged` is now a thin HealthStore reader.
 * Detection logic moved into `CheckRunner.runLanIpDriftCheck` — these
 * tests cover the reader-side contract only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckResult } from '@/lib/health/types';

const state = {
  results: new Map<string, CheckResult>(),
};

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getLastResult: (id: string) => state.results.get(id) ?? null,
  },
}));

import { checkLanIpChanged } from './lanIpChanged';

beforeEach(() => {
  state.results = new Map();
});

describe('checkLanIpChanged (reader)', () => {
  it('returns info when HealthStore has no result yet', async () => {
    const out = await checkLanIpChanged();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/has not run yet/);
  });

  it('decodes a happy-path warn payload', async () => {
    const payload = {
      status: 'warn',
      detail: 'LAN IP is now 10.0.0.5, but install-time was 10.0.0.4.',
      hint: 'A one-off change is fine.',
    };
    state.results.set('lan_ip_drift', {
      check_id: 'lan_ip_drift',
      timestamp: new Date().toISOString(),
      status: 'ok',
      message: `lan_ip_drift:${JSON.stringify(payload)}`,
      latency: 100,
    });
    const out = await checkLanIpChanged();
    expect(out.status).toBe('warn');
    expect(out.detail).toBe(payload.detail);
    expect(out.hint).toBe(payload.hint);
  });

  it('decodes an ok payload', async () => {
    const payload = { status: 'ok', detail: 'LAN IP 10.0.0.5 matches the install-time value.' };
    state.results.set('lan_ip_drift', {
      check_id: 'lan_ip_drift',
      timestamp: new Date().toISOString(),
      status: 'ok',
      message: `lan_ip_drift:${JSON.stringify(payload)}`,
      latency: 100,
    });
    const out = await checkLanIpChanged();
    expect(out.status).toBe('ok');
    expect(out.detail).toBe(payload.detail);
  });

  it('surfaces transport-error plaintext as info', async () => {
    state.results.set('lan_ip_drift', {
      check_id: 'lan_ip_drift',
      timestamp: new Date().toISOString(),
      status: 'fail',
      message: 'lan_ip_drift error: agent unreachable',
      latency: 100,
    });
    const out = await checkLanIpChanged();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/Check failed to run.*agent unreachable/);
  });
});
