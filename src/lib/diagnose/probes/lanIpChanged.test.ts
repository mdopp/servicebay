/**
 * Phase 3b (#484): `checkLanIpChanged` is now a thin HealthStore reader.
 * Detection logic moved into `CheckRunner.runLanIpDriftCheck` — these
 * tests cover the reader-side contract.
 *
 * #549: Added action-dispatch tests for `reconcile_lan_ip` +
 * `show_fritzbox_reservation_instructions`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckResult } from '@/lib/health/types';

const state = {
  results: new Map<string, CheckResult>(),
  checks: [{ id: 'lan_ip_drift' }] as Array<{ id: string }>,
  reconcileResult: '192.168.1.10' as string | null,
  provisionResult: { ok: true, detail: 'all 3 rewrites in place' } as { ok: boolean; detail: string },
  config: {
    gateway: { type: 'fritzbox' as const, host: '192.168.1.1' },
    reverseProxy: { lanIp: '192.168.1.10' },
  } as any,
};

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getLastResult: (id: string) => state.results.get(id) ?? null,
    getChecks: () => state.checks,
  },
}));

vi.mock('@/lib/lanIp', () => ({
  reconcileLanIp: vi.fn(() => Promise.resolve(state.reconcileResult)),
}));

vi.mock('@/lib/portal/provisioner', () => ({
  provisionPortalRouting: vi.fn(() => Promise.resolve(state.provisionResult)),
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./refreshHealthCheck', () => ({
  registerRefreshNow: vi.fn(),
}));

import { checkLanIpChanged } from './lanIpChanged';
import { dispatchProbeAction, actionsForProbe } from '../actions';

beforeEach(() => {
  state.results = new Map();
  state.checks = [{ id: 'lan_ip_drift' }];
  state.reconcileResult = '192.168.1.10';
  state.provisionResult = { ok: true, detail: 'all 3 rewrites in place' };
  state.config = {
    gateway: { type: 'fritzbox', host: '192.168.1.1' },
    reverseProxy: { lanIp: '192.168.1.10' },
  };
});

describe('checkLanIpChanged (reader)', () => {
  it('returns info when HealthStore has no result yet (check exists, first run pending)', async () => {
    const out = await checkLanIpChanged();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/first run pending/);
  });

  it('reports the missing-prereq state when the lan_ip_drift check has not been created yet (#664)', async () => {
    state.checks = [];
    const out = await checkLanIpChanged();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/install-time LAN-IP/);
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

describe('lan_ip_changed_since_install action registration', () => {
  it('registers reconcile_lan_ip and show_fritzbox_reservation_instructions', () => {
    const ids = actionsForProbe('lan_ip_changed_since_install')
      .map(a => a.id)
      .sort();
    // refresh_now is registered via the registerRefreshNow mock — not present here.
    expect(ids).toEqual(['reconcile_lan_ip', 'show_fritzbox_reservation_instructions']);
  });
});

describe('lan_ip_changed_since_install.reconcile_lan_ip', () => {
  it('returns ok with the new IP when reconcile + provision succeed', async () => {
    state.reconcileResult = '192.168.1.20';
    const result = await dispatchProbeAction({
      probeId: 'lan_ip_changed_since_install',
      actionId: 'reconcile_lan_ip',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('192.168.1.20');
    expect(result.refresh).toBe(true);
  });

  it('reports the actual provisioner detail in the success case', async () => {
    state.reconcileResult = '192.168.1.20';
    state.provisionResult = { ok: true, detail: 'added 1 rewrite, kept 2 unchanged' };
    const result = await dispatchProbeAction({
      probeId: 'lan_ip_changed_since_install',
      actionId: 'reconcile_lan_ip',
      node: 'Local',
    });
    expect(result.details).toContain('added 1 rewrite');
  });

  it('fails cleanly when LAN IP detection returns null', async () => {
    state.reconcileResult = null;
    const result = await dispatchProbeAction({
      probeId: 'lan_ip_changed_since_install',
      actionId: 'reconcile_lan_ip',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not detect/);
  });

  it('flags provisioner failures but still surfaces the new IP', async () => {
    state.reconcileResult = '192.168.1.30';
    state.provisionResult = { ok: false, detail: 'AdGuard returned 502 for /control/rewrite/list' };
    const result = await dispatchProbeAction({
      probeId: 'lan_ip_changed_since_install',
      actionId: 'reconcile_lan_ip',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('192.168.1.30');
    expect(result.details).toContain('AdGuard returned 502');
    // refresh: true so the operator's diagnose page picks up the new
    // config-stored IP even though the provisioner half failed.
    expect(result.refresh).toBe(true);
  });
});

describe('lan_ip_changed_since_install.show_fritzbox_reservation_instructions', () => {
  it('renders FritzBox-specific steps when gateway is configured as FritzBox', async () => {
    const result = await dispatchProbeAction({
      probeId: 'lan_ip_changed_since_install',
      actionId: 'show_fritzbox_reservation_instructions',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.details).toContain('FritzBox');
    expect(result.details).toContain('Heimnetz');
    // Names the actual configured LAN IP so the operator can correlate
    // with the row in the FritzBox UI.
    expect(result.details).toContain('192.168.1.10');
  });

  it('falls back to vendor-neutral steps for non-FritzBox gateways', async () => {
    state.config = {
      gateway: { type: 'generic', host: '10.0.0.1' },
      reverseProxy: { lanIp: '10.0.0.5' },
    };
    const result = await dispatchProbeAction({
      probeId: 'lan_ip_changed_since_install',
      actionId: 'show_fritzbox_reservation_instructions',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.details).not.toContain('Heimnetz');
    expect(result.details).toMatch(/DHCP reservation|Static lease/);
    expect(result.details).toContain('10.0.0.5');
  });
});
