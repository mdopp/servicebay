/**
 * Host-firewall capability handler tests (#2388).
 *
 * The render/apply mechanics are covered in `lib/hostFirewall.test.ts`;
 * here we pin the routing decisions that determine WHICH ports end up
 * filtered — above all that uninstall really removes them, since a
 * firewall rule outliving its service is this feature's worst failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reconcileMock = vi.fn();
const getConfigMock = vi.fn();
const getTemplateVariablesMock = vi.fn();
const recordFailureMock = vi.fn();
const clearFailureMock = vi.fn();

vi.mock('@/lib/install/handlerFailures', () => ({
  recordHandlerFailure: (...a: unknown[]) => recordFailureMock(...a),
  clearHandlerFailure: (...a: unknown[]) => clearFailureMock(...a),
}));

vi.mock('@/lib/config', () => ({ getConfig: () => getConfigMock() }));
vi.mock('@/lib/executor', () => ({ getExecutor: () => ({ tag: 'executor' }) }));
vi.mock('@/lib/registry', () => ({
  getTemplateVariables: (name: string) => getTemplateVariablesMock(name),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/hostFirewall', async () => {
  const actual = await vi.importActual<typeof import('@/lib/hostFirewall')>('@/lib/hostFirewall');
  return { ...actual, reconcileHostFirewall: (...a: unknown[]) => reconcileMock(...a) };
});

import {
  handleInstalled,
  handleUninstalled,
  reconcileHostFirewallOnBoot,
  planLanBlockedPorts,
  BOOT_FAILURE_SERVICE,
} from './hostFirewall';
import type { TemplateManifest } from '@/lib/template/contract';

const MANIFEST: TemplateManifest = { label: 'Sign-In Gate', tier: 'infrastructure', schemaVersion: 3, dependencies: [], seedOnlyConfigs: [] };

const AUTH_VARS = {
  LLDAP_LDAP_PORT: { blockLanAccess: true, default: '3890' },
  LLDAP_PORT: { default: '17170' },
};

/** Ports the handler asked the host layer to filter. */
const appliedPorts = (): number[] => reconcileMock.mock.calls.at(-1)?.[1] as number[];

beforeEach(() => {
  vi.clearAllMocks();
  reconcileMock.mockResolvedValue(undefined);
  getConfigMock.mockResolvedValue({
    installedTemplates: { auth: { schemaVersion: 3, installedAt: 'x' }, media: { schemaVersion: 6, installedAt: 'x' } },
    templateSettings: { DATA_DIR: '/mnt/data/stacks' },
  });
  getTemplateVariablesMock.mockImplementation(async (name: string) => (name === 'auth' ? AUTH_VARS : {}));
});

describe('host-firewall handler — install (#2388)', () => {
  it('filters the port the installed template declared', async () => {
    await expect(handleInstalled({ kind: 'feature.installed', template: 'auth', manifest: MANIFEST, variables: [] }))
      .resolves.toEqual({ ok: true });
    expect(appliedPorts()).toEqual([3890]);
  });

  it('folds in a template config has not stamped as installed yet', async () => {
    // On a FIRST install the event can fire before `installedTemplates`
    // is written; reading config alone would miss the brand-new port.
    getConfigMock.mockResolvedValue({ installedTemplates: {}, templateSettings: {} });
    await handleInstalled({ kind: 'feature.installed', template: 'auth', manifest: MANIFEST, variables: [] });
    expect(appliedPorts()).toEqual([3890]);
  });

  it('prefers the event value over config and over the declared default', async () => {
    await handleInstalled({
      kind: 'feature.installed',
      template: 'auth',
      manifest: MANIFEST,
      variables: [{ name: 'LLDAP_LDAP_PORT', value: '3899' }],
    });
    expect(appliedPorts()).toEqual([3899]);
  });

  it('installing an unrelated template still re-asserts the existing filter', async () => {
    await handleInstalled({ kind: 'feature.installed', template: 'media', manifest: MANIFEST, variables: [] });
    expect(appliedPorts()).toEqual([3890]);
  });

  it('reports a retryable failure so a silent non-applied rule cannot pass as success', async () => {
    reconcileMock.mockRejectedValue(new Error('sudo: no'));
    const res = await handleInstalled({ kind: 'feature.installed', template: 'auth', manifest: MANIFEST, variables: [] });
    expect(res).toEqual({ ok: false, retryable: true, message: expect.stringContaining('host firewall apply for auth') });
  });
});

describe('host-firewall handler — uninstall (#2388)', () => {
  it('drops the uninstalled template even if config still lists it', async () => {
    // The wipe route's ordering is not this module's business: exclude
    // explicitly so a not-yet-rewritten config cannot strand the rule.
    await expect(
      handleUninstalled({ kind: 'feature.uninstalled', template: 'auth', lastKnownVariables: [] }),
    ).resolves.toEqual({ ok: true });
    expect(appliedPorts()).toEqual([]);
  });

  it('keeps another template\'s ports when only one is removed', async () => {
    getTemplateVariablesMock.mockImplementation(async (name: string) => {
      if (name === 'auth') return AUTH_VARS;
      if (name === 'media') return { MEDIA_RAW_PORT: { blockLanAccess: true, default: '9999' } };
      return {};
    });
    await handleUninstalled({ kind: 'feature.uninstalled', template: 'auth', lastKnownVariables: [] });
    expect(appliedPorts()).toEqual([9999]);
  });

  it('surfaces a cleanup failure rather than swallowing it', async () => {
    reconcileMock.mockRejectedValue(new Error('nft gone'));
    const res = await handleUninstalled({ kind: 'feature.uninstalled', template: 'auth', lastKnownVariables: [] });
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).toContain('cleanup for auth');
  });
});

describe('host-firewall boot reconcile (#2388)', () => {
  it('applies the declared port for an ALREADY-installed stack, no redeploy needed', async () => {
    // This is what closes the gap on the live box: `auth` was installed
    // before the template declared the flag, so nothing would ever emit
    // feature.installed for it again.
    await reconcileHostFirewallOnBoot();
    expect(appliedPorts()).toEqual([3890]);
  });

  it('asks for an empty set (i.e. teardown) when nothing declares the flag', async () => {
    getTemplateVariablesMock.mockResolvedValue({ LLDAP_PORT: { default: '17170' } });
    await reconcileHostFirewallOnBoot();
    expect(appliedPorts()).toEqual([]);
  });

  it('propagates a failure to the caller, which logs it', async () => {
    reconcileMock.mockRejectedValue(new Error('agent down'));
    await expect(reconcileHostFirewallOnBoot()).rejects.toThrow(/agent down/);
  });
});

/**
 * #2420 — a boot reconcile that fails must leave a standing finding, not
 * just a log line. It writes the same `installHandlerFailures` store the
 * capability-bus path uses via `runner.ts`, so `install_handler_failed`
 * surfaces it with a Retry.
 */
describe('host-firewall boot reconcile — failure is surfaced (#2420)', () => {
  it('records a standing failure the diagnose probe can read', async () => {
    reconcileMock.mockRejectedValue(new Error('sudo: a password is required'));
    await expect(reconcileHostFirewallOnBoot()).rejects.toThrow(/password/);
    expect(recordFailureMock).toHaveBeenCalledWith({
      kind: 'host-firewall',
      service: BOOT_FAILURE_SERVICE,
      message: expect.stringContaining('boot reconcile: sudo: a password is required'),
    });
    expect(clearFailureMock).not.toHaveBeenCalled();
  });

  it('clears the record once a later boot converges', async () => {
    await reconcileHostFirewallOnBoot();
    expect(recordFailureMock).not.toHaveBeenCalled();
    expect(clearFailureMock).toHaveBeenCalledWith('host-firewall', BOOT_FAILURE_SERVICE);
  });
});

describe('planLanBlockedPorts (#2420)', () => {
  it('reports the desired port set without touching the host', async () => {
    const plan = await planLanBlockedPorts();
    expect(plan.ports).toEqual([3890]);
    expect(reconcileMock).not.toHaveBeenCalled();
  });
});
