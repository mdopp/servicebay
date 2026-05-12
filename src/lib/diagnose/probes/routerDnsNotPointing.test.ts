/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  setResult: { result: 'ok' } as any,
  reconnectResult: { result: 'ok' } as any,
};

vi.mock('@/lib/router/dnsConfig', () => ({
  setFritzBoxDhcpDns: vi.fn(() => Promise.resolve(state.setResult)),
  reconnectFritzBox: vi.fn(() => Promise.resolve(state.reconnectResult)),
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve({
    reverseProxy: { lanIp: '192.168.1.10' },
    gateway: { type: 'fritzbox', host: '192.168.1.1', username: 'admin', password: 'secret' },
  })),
  updateConfig: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { dispatchProbeAction } from '../actions';
import './routerDnsNotPointing';

beforeEach(() => {
  state.setResult = { result: 'ok' };
  state.reconnectResult = { result: 'ok' };
});

describe('router_dns_not_pointing.reconnect_fritzbox', () => {
  it('returns ok with reconnect-window guidance on success', async () => {
    const result = await dispatchProbeAction({
      probeId: 'router_dns_not_pointing',
      actionId: 'reconnect_fritzbox',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/reconnecting/);
    expect(result.refresh).toBe(true);
  });

  it('surfaces the helper detail when reconnect fails', async () => {
    state.reconnectResult = { result: 'failed', detail: 'TR-064 disabled' };
    const result = await dispatchProbeAction({
      probeId: 'router_dns_not_pointing',
      actionId: 'reconnect_fritzbox',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('TR-064 disabled');
  });

  it('returns a credential-specific message when the box rejects auth', async () => {
    state.reconnectResult = { result: 'no_credentials', detail: 'FritzBox rejected the TR-064 credentials.' };
    const result = await dispatchProbeAction({
      probeId: 'router_dns_not_pointing',
      actionId: 'reconnect_fritzbox',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('rejected the TR-064 credentials');
  });

  it('falls back to a generic message when the helper returns no detail', async () => {
    state.reconnectResult = { result: 'failed' };
    const result = await dispatchProbeAction({
      probeId: 'router_dns_not_pointing',
      actionId: 'reconnect_fritzbox',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    // Generic fallback should mention "Neu verbinden" so the user knows the
    // manual workaround.
    expect(result.message).toMatch(/Neu verbinden/);
  });
});
