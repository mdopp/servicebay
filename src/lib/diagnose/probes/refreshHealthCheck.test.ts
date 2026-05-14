import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckConfig } from '@/lib/health/types';

const checks: CheckConfig[] = [];
const runMock = vi.fn();

vi.mock('@/lib/health/store', () => ({
  HealthStore: { getChecks: () => checks },
}));

vi.mock('@/lib/health/runner', () => ({
  CheckRunner: { run: (c: CheckConfig) => runMock(c) },
}));

import { makeRefreshNowAction } from './refreshHealthCheck';

beforeEach(() => {
  checks.length = 0;
  runMock.mockReset();
});

describe('refresh_now handler (shared)', () => {
  it('runs the matching singleton check via CheckRunner and returns ok=true', async () => {
    const check: CheckConfig = {
      id: 'npm_auth',
      name: 'NPM auth',
      type: 'npm_auth',
      target: '',
      interval: 900,
      enabled: true,
      created_at: '2024-01-01T00:00:00Z',
    };
    checks.push(check);
    runMock.mockResolvedValue({ status: 'ok', message: '' });

    const { handler } = makeRefreshNowAction('npm_auth', 'NPM auth');
    const r = await handler({ node: 'Local' });
    expect(runMock).toHaveBeenCalledWith(check);
    expect(r.ok).toBe(true);
    expect(r.refresh).toBe(true);
    expect(r.message).toMatch(/NPM auth re-run/);
  });

  it('returns ok=false (with refresh) when the singleton check is not registered yet', async () => {
    const { handler } = makeRefreshNowAction('cert_expiry', 'Cert expiry');
    const r = await handler({ node: 'Local' });
    expect(runMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.refresh).toBe(true);
    expect(r.message).toMatch(/should appear automatically/);
  });

  it('returns ok=false when CheckRunner throws', async () => {
    checks.push({
      id: 'lan_ip_drift',
      name: 'LAN IP',
      type: 'lan_ip_drift',
      target: '',
      interval: 300,
      enabled: true,
      created_at: '2024-01-01T00:00:00Z',
    });
    runMock.mockRejectedValue(new Error('agent unreachable'));

    const { handler } = makeRefreshNowAction('lan_ip_drift', 'LAN IP drift');
    const r = await handler({ node: 'Local' });
    expect(r.ok).toBe(false);
    expect(r.refresh).toBe(false);
    expect(r.message).toMatch(/agent unreachable/);
  });

  it('builds an action with the standard refresh_now id and a label-aware description', () => {
    const { action } = makeRefreshNowAction('cert_expiry', 'Cert expiry');
    expect(action.id).toBe('refresh_now');
    expect(action.label).toBe('Refresh now');
    expect(action.description).toMatch(/Cert expiry/);
  });
});
