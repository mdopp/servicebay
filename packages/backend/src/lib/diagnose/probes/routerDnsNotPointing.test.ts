/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  setResult: { result: 'ok' } as any,
  reconnectResult: { result: 'ok' } as any,
  setWanResult: { result: 'ok' } as any,
  config: {
    reverseProxy: { lanIp: '192.168.1.10', publicDomain: 'dopp.cloud' },
    gateway: { type: 'fritzbox', host: '192.168.1.1', username: 'admin', password: 'secret' },
  } as any,
};

vi.mock('@/lib/router/dnsConfig', () => ({
  setFritzBoxDhcpDns: vi.fn(() => Promise.resolve(state.setResult)),
  setFritzBoxWanDns: vi.fn(() => Promise.resolve(state.setWanResult)),
  reconnectFritzBox: vi.fn(() => Promise.resolve(state.reconnectResult)),
}));

const lanResolve = vi.fn(
  (_host: string, _ip: string): Promise<string[] | null> => Promise.resolve(null),
);
vi.mock('@/lib/router/lanResolver', () => ({
  resolve4ViaLan: (h: string, ip: string) => lanResolve(h, ip),
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
  updateConfig: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { dispatchProbeAction } from '../actions';
import './routerDnsNotPointing';
import { checkRouterDnsNotPointing } from './routerDnsNotPointing';

beforeEach(() => {
  state.setResult = { result: 'ok' };
  state.reconnectResult = { result: 'ok' };
  state.setWanResult = { result: 'ok' };
  state.config = {
    reverseProxy: { lanIp: '192.168.1.10', publicDomain: 'dopp.cloud' },
    gateway: { type: 'fritzbox', host: '192.168.1.1', username: 'admin', password: 'secret' },
  };
  lanResolve.mockReset();
  lanResolve.mockResolvedValue(null);
  // Default: TR-064 reads + AdGuard query-log fetches all fail fast so the
  // only positive signal in the LAN-path tests is `resolve4ViaLan`.
  vi.spyOn(globalThis, 'fetch').mockReset().mockRejectedValue(new Error('no network in test'));
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

describe('router_dns_not_pointing.configure_fritzbox_upstream', () => {
  it('returns ok with a topology-aware success message', async () => {
    const result = await dispatchProbeAction({
      probeId: 'router_dns_not_pointing',
      actionId: 'configure_fritzbox_upstream',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    // Success message should name the topology so the operator knows
    // which valid pattern they just locked in.
    expect(result.message).toMatch(/upstream/);
    expect(result.message).toContain('192.168.1.10');
    expect(result.refresh).toBe(true);
  });

  it('surfaces the "switch to Use other DNSv4 servers" hint on failure', async () => {
    state.setWanResult = {
      result: 'failed',
      detail: 'FritzBox declined SetDNSServers on both WAN services. Most common cause: "Internet → Account Information → DNS Server" is set to "From provider" — switch it to "Use other DNSv4 servers" once and retry; subsequent TR-064 writes then succeed.',
    };
    const result = await dispatchProbeAction({
      probeId: 'router_dns_not_pointing',
      actionId: 'configure_fritzbox_upstream',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Use other DNSv4 servers/);
  });

  it('returns a credential-specific message when the box rejects auth', async () => {
    state.setWanResult = {
      result: 'no_credentials',
      detail: 'FritzBox rejected the TR-064 credentials. Re-check Settings → Gateway.',
    };
    const result = await dispatchProbeAction({
      probeId: 'router_dns_not_pointing',
      actionId: 'configure_fritzbox_upstream',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('rejected the TR-064 credentials');
  });

  it('treats an unsupported TR-064 model as actionable success (manual DNS, not a red)', async () => {
    state.setWanResult = {
      result: 'unsupported',
      detail: "This FritzBox doesn't support setting DNS over TR-064 (UPnP 401 — Invalid Action). Set the upstream DNS manually...",
    };
    const result = await dispatchProbeAction({
      probeId: 'router_dns_not_pointing',
      actionId: 'configure_fritzbox_upstream',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/doesn't support setting DNS over TR-064/);
    expect(result.refresh).toBe(true);
  });
});

describe('router_dns_not_pointing.configure_fritzbox (DHCP) unsupported model', () => {
  it('treats an unsupported DHCP write as actionable success', async () => {
    state.setResult = {
      result: 'unsupported',
      detail: "This FritzBox doesn't support setting DNS over TR-064 (UPnP 501). Set the DHCP DNS server manually...",
    };
    const result = await dispatchProbeAction({
      probeId: 'router_dns_not_pointing',
      actionId: 'configure_fritzbox',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/UPnP 501/);
    expect(result.refresh).toBe(true);
  });
});

describe('checkRouterDnsNotPointing — effective LAN-path signal (#1672)', () => {
  it('reads GREEN when *.<domain> resolves to the box via AdGuard, even though TR-064 reads fail', async () => {
    // All TR-064/AdGuard signals negative (fetch rejects); only the LAN
    // resolution path is positive — a manually/DHCP-correct box.
    lanResolve.mockImplementation((host: string) =>
      host === 'auth.dopp.cloud' ? Promise.resolve(['192.168.1.10']) : Promise.resolve(null),
    );
    const r = await checkRouterDnsNotPointing();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/effective LAN DNS path is correct/);
    expect(lanResolve).toHaveBeenCalledWith('auth.dopp.cloud', '192.168.1.10');
  });

  it('reads WARN when neither TR-064, AdGuard query log, nor the LAN path confirm the box', async () => {
    lanResolve.mockResolvedValue(['203.0.113.9']); // resolves, but to a non-box IP
    const r = await checkRouterDnsNotPointing();
    expect(r.status).toBe('warn');
  });

  it('does not run the LAN-path resolution when a TR-064/query-log signal is already positive', async () => {
    // AdGuard creds present + the query log returns a LAN client → adguardOk
    // short-circuits, so the LAN-path resolution never runs.
    state.config = {
      reverseProxy: { lanIp: '192.168.1.10', publicDomain: 'dopp.cloud' },
      gateway: { type: 'fritzbox', host: '192.168.1.1' }, // no creds → TR-064 reads skipped
      adguard: { adminUrl: 'http://localhost:8083', username: 'admin', password: 'pw' },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ client: '192.168.1.55', T: new Date().toISOString() }] }),
      text: async () => '',
    } as any);
    const r = await checkRouterDnsNotPointing();
    expect(r.status).toBe('ok');
    expect(lanResolve).not.toHaveBeenCalled();
  });
});
