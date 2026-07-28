/**
 * `host_firewall_rule` probe tests (#2420).
 *
 * The load-bearing one is `mutation-prove`: a boot reconcile that RETURNS
 * SUCCESS while the rule is absent must still be caught, because that is
 * precisely what the old code trusted. Every assertion here therefore
 * drives the probe off the fake host's ruleset, never off the return
 * value of the reconcile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const planMock = vi.fn();
const inspectMock = vi.fn();
const reconcileOnBootMock = vi.fn();

vi.mock('@/lib/executor', () => ({ getExecutor: () => ({ tag: 'executor' }) }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/capabilities/hostFirewall', () => ({
  planLanBlockedPorts: () => planMock(),
  reconcileHostFirewallOnBoot: () => reconcileOnBootMock(),
}));
vi.mock('@/lib/hostFirewall', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hostFirewall')>('@/lib/hostFirewall');
  return { ...actual, inspectHostFirewall: (...a: unknown[]) => inspectMock(...a) };
});

import { checkHostFirewallRule } from './hostFirewallRule';
import { dispatchProbeAction } from '../actions';
import './hostFirewallRule';

/** Live-host state: rule fully loaded and persistent. */
const loaded = (ports: number[]) => ({
  nftAvailable: true,
  tableLoaded: true,
  loadedPorts: ports,
  unitEnabled: 'enabled',
  unitActive: 'active',
});

beforeEach(() => {
  vi.clearAllMocks();
  planMock.mockResolvedValue({ ports: [3890], skipped: [] });
  inspectMock.mockResolvedValue(loaded([3890]));
  reconcileOnBootMock.mockResolvedValue(undefined);
});

describe('host_firewall_rule probe (#2420)', () => {
  it('is green when the declared port is really in the live ruleset', async () => {
    const res = await checkHostFirewallRule();
    expect(res.status).toBe('ok');
    expect(res.detail).toContain('3890');
    expect(res.items).toBeUndefined();
  });

  it('is green (nothing expected) when no template declares an on-box-only port', async () => {
    planMock.mockResolvedValue({ ports: [], skipped: [] });
    const res = await checkHostFirewallRule();
    expect(res.status).toBe('ok');
    // No host round-trip needed when nothing is desired.
    expect(inspectMock).not.toHaveBeenCalled();
  });

  it('fails with a retry action when the nft binary is absent', async () => {
    inspectMock.mockResolvedValue({
      nftAvailable: false, tableLoaded: false, loadedPorts: [], unitEnabled: 'not-found', unitActive: 'inactive',
    });
    const res = await checkHostFirewallRule();
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('nft is not installed');
    expect(res.detail).toContain('3890');
    expect(res.items?.[0].actionIds).toContain('reapply_host_firewall');
  });

  it('fails with a retry action when the table was dropped', async () => {
    inspectMock.mockResolvedValue({
      nftAvailable: true, tableLoaded: false, loadedPorts: [], unitEnabled: 'enabled', unitActive: 'inactive',
    });
    const res = await checkHostFirewallRule();
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('servicebay_lanblock');
    expect(res.items?.[0].actionIds).toContain('reapply_host_firewall');
  });

  it('fails when the table is loaded but is missing a declared port', async () => {
    planMock.mockResolvedValue({ ports: [3890, 9999], skipped: [] });
    inspectMock.mockResolvedValue(loaded([3890]));
    const res = await checkHostFirewallRule();
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('9999');
    expect(res.items?.[0].actionIds).toContain('reapply_host_firewall');
  });

  it('warns when the rule is live but the boot unit will not bring it back', async () => {
    inspectMock.mockResolvedValue({ ...loaded([3890]), unitEnabled: 'disabled', unitActive: 'active' });
    const res = await checkHostFirewallRule();
    expect(res.status).toBe('warn');
    expect(res.detail).toContain('reboot');
  });

  it('warns (not "ok") when the live ruleset could not be read at all', async () => {
    inspectMock.mockResolvedValue({
      nftAvailable: true, tableLoaded: false, loadedPorts: [], unitEnabled: 'enabled', unitActive: 'active',
      error: 'sudo: a password is required',
    });
    const res = await checkHostFirewallRule();
    expect(res.status).toBe('warn');
    expect(res.detail).toContain('unverified');
  });

  it('mutation-prove: a boot reconcile that RETURNS SUCCESS with the rule absent is still caught', async () => {
    // Exactly the pre-#2420 blind spot: the call resolves happily…
    await expect(reconcileOnBootMock()).resolves.toBeUndefined();
    // …while the kernel holds nothing. The probe reads the host, so it fails.
    inspectMock.mockResolvedValue({
      nftAvailable: true, tableLoaded: false, loadedPorts: [], unitEnabled: 'enabled', unitActive: 'active',
    });
    const res = await checkHostFirewallRule();
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('NOT loaded');
  });
});

describe('reapply_host_firewall action (#2420)', () => {
  it('re-applies and then re-reads the host before claiming success', async () => {
    // The re-apply converged, so the post-check read finds the rule live.
    inspectMock.mockResolvedValue(loaded([3890]));
    const result = await dispatchProbeAction({
      probeId: 'host_firewall_rule', actionId: 'reapply_host_firewall', node: 'Local',
    });
    expect(reconcileOnBootMock).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.refresh).toBe(true);
  });

  it('reports not-ok when the rule is still absent after the re-apply', async () => {
    inspectMock.mockResolvedValue({
      nftAvailable: true, tableLoaded: false, loadedPorts: [], unitEnabled: 'enabled', unitActive: 'active',
    });
    const result = await dispatchProbeAction({
      probeId: 'host_firewall_rule', actionId: 'reapply_host_firewall', node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('still');
  });

  it('surfaces the apply error rather than swallowing it', async () => {
    reconcileOnBootMock.mockRejectedValue(new Error('sudo: no'));
    const result = await dispatchProbeAction({
      probeId: 'host_firewall_rule', actionId: 'reapply_host_firewall', node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('sudo: no');
  });
});
