/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockConfig: any = {};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(mockConfig)),
  saveConfig: vi.fn((cfg: any) => {
    mockConfig = cfg;
    return Promise.resolve();
  }),
}));

// Keep the capability/internalFetch deps out of the probe's load graph for
// these finding/dismiss tests (retry_capability isn't exercised here).
vi.mock('@/lib/api/internalFetch', () => ({ internalFetch: vi.fn() }));
vi.mock('@/lib/capabilities/authelia', () => ({ buildOidcReconcilePayload: vi.fn() }));

// #2420 — the host-firewall retry path re-runs the boot reconcile; stub it
// so the test never reaches an executor.
const reconcileOnBootMock = vi.fn(() => Promise.resolve());
vi.mock('@/lib/capabilities/hostFirewall', () => ({
  reconcileHostFirewallOnBoot: () => reconcileOnBootMock(),
}));

import { checkInstallHandlerFailed } from './installHandlerFailed';
import { dispatchProbeAction } from '../actions';
import './installHandlerFailed';
import { recordHandlerFailure } from '@/lib/install/handlerFailures';

beforeEach(() => {
  mockConfig = {};
});

describe('install_handler_failed probe (#2160/#2161)', () => {
  it('is ok with no standing failures', async () => {
    const res = await checkInstallHandlerFailed();
    expect(res.status).toBe('ok');
    expect(res.items).toBeUndefined();
  });

  it('emits a warn finding with a retry action per standing failure', async () => {
    await recordHandlerFailure({ kind: 'capability', service: 'immich', message: 'authelia.oidc: HTTP 500' });
    await recordHandlerFailure({ kind: 'restore', service: 'radicale', message: 'NAS config restore failed: refused' });

    const res = await checkInstallHandlerFailed();
    expect(res.status).toBe('warn');
    expect(res.items).toHaveLength(2);
    const cap = res.items!.find(i => i.id === 'capability:immich')!;
    expect(cap.status).toBe('warn');
    expect(cap.actionIds).toContain('retry_install_handler');
    expect(cap.detail).toContain('authelia.oidc');
    const restore = res.items!.find(i => i.id === 'restore:radicale')!;
    expect(restore.detail).toContain('NAS restore');
  });

  it('dismiss action clears the standing record', async () => {
    await recordHandlerFailure({ kind: 'capability', service: 'immich', message: 'x' });
    const result = await dispatchProbeAction({
      probeId: 'install_handler_failed',
      actionId: 'dismiss_install_handler',
      node: 'Local',
      itemId: 'capability:immich',
    });
    expect(result.ok).toBe(true);
    expect((await checkInstallHandlerFailed()).status).toBe('ok');
  });

  it('surfaces a boot-time host-firewall failure as a standing row with a retry (#2420)', async () => {
    await recordHandlerFailure({
      kind: 'host-firewall',
      service: 'host-firewall',
      message: 'boot reconcile: sudo: a password is required',
    });
    const res = await checkInstallHandlerFailed();
    expect(res.status).toBe('warn');
    const row = res.items!.find(i => i.id === 'host-firewall:host-firewall')!;
    expect(row.detail).toContain('host firewall reconcile (LAN block)');
    expect(row.detail).toContain('sudo');
    expect(row.actionIds).toContain('retry_install_handler');
  });

  it('retry on a host-firewall row re-runs the reconcile (#2420)', async () => {
    await recordHandlerFailure({ kind: 'host-firewall', service: 'host-firewall', message: 'boot reconcile: nft gone' });
    const result = await dispatchProbeAction({
      probeId: 'install_handler_failed',
      actionId: 'retry_install_handler',
      node: 'Local',
      itemId: 'host-firewall:host-firewall',
    });
    expect(reconcileOnBootMock).toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('rejects an unrecognized item id', async () => {
    const result = await dispatchProbeAction({
      probeId: 'install_handler_failed',
      actionId: 'retry_install_handler',
      node: 'Local',
      itemId: 'bogus',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Unrecognized/);
  });
});
