/**
 * The boot re-assert must LAN-block the port the operator actually set
 * (#2551), and this test proves it at the only place that matters: the
 * nftables ruleset that goes to the host.
 *
 * Why a separate file from `hostFirewall.test.ts`: that suite mocks
 * `reconcileHostFirewall` away to pin routing decisions, so it can only ever
 * assert "we asked for port N". The defect #2551 describes is a security
 * control that was *applied successfully* to the wrong port — nftables
 * filtered a port nothing listens on while the port LLDAP actually binds
 * stayed reachable from the LAN. Proving that is fixed requires the REAL
 * render/apply path and an assertion on the rendered rule, so this file
 * mocks config/registry/executor and nothing else.
 *
 * The path under test carries NO event variables (`reconcileHostFirewallOnBoot`
 * calls `reconcileFromConfig()` with no opts) — that is precisely where the
 * old `templateSettings`-then-declared-default chain fell back to the
 * template DEFAULT and silently voided #2388.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getConfigMock = vi.fn();
const getTemplateVariablesMock = vi.fn();

/** Files the reconcile wrote, by path — the rendered ruleset lands here. */
let writes: Record<string, string> = {};
let argvCalls: string[][] = [];

vi.mock('@/lib/config', () => ({
  getConfig: () => getConfigMock(),
  updateConfig: vi.fn(async () => undefined),
}));
vi.mock('@/lib/registry', () => ({
  getTemplateVariables: (name: string) => getTemplateVariablesMock(name),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/install/handlerFailures', () => ({
  recordHandlerFailure: vi.fn(async () => undefined),
  clearHandlerFailure: vi.fn(async () => undefined),
}));
vi.mock('@/lib/executor', () => ({
  getExecutor: () => ({
    // #2737: argv rides execSafe (`sudo` is an option); the genuinely-shell
    // commands still arrive as a string on `exec`.
    exec: async (command: string) => {
      argvCalls.push(command.split(' '));
      if (command.includes('command -v nft')) return { stdout: '/usr/sbin/nft\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    execSafe: async (argv: string[], o?: { sudo?: boolean }) => {
      argvCalls.push(o?.sudo ? ['sudo', ...argv] : argv);
      return { stdout: '', stderr: '', code: 0 };
    },
    writeFile: async (path: string, content: string) => {
      writes[path] = content;
    },
    exists: async () => false,
  }),
}));

import { reconcileHostFirewallOnBoot } from './hostFirewall';

/** LLDAP's raw LDAP port — the only shipped `blockLanAccess` variable. */
const AUTH_VARS = {
  LLDAP_LDAP_PORT: { blockLanAccess: true, default: '3890' },
  LLDAP_PORT: { default: '17170' },
};

/** The ruleset the boot re-assert validated and installed. */
const renderedRuleset = () => writes['/tmp/servicebay-host-firewall.nft'] ?? '';

/** Ports inside the nft set the base chain matches on. */
const filteredPorts = (): number[] => {
  const match = /elements\s*=\s*\{([^}]*)\}/.exec(renderedRuleset());
  if (!match) return [];
  return match[1].split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n));
};

beforeEach(() => {
  vi.clearAllMocks();
  writes = {};
  argvCalls = [];
  getTemplateVariablesMock.mockImplementation(async (name: string) => (name === 'auth' ? AUTH_VARS : {}));
});

describe('host-firewall boot re-assert blocks the OPERATOR-set port (#2551)', () => {
  it('renders the nftables rule for the operator-set port, not the template default', async () => {
    // The operator changed LLDAP_LDAP_PORT in Configure. #2531 records that
    // in `installedVariables`; it is NOT a global Template Setting.
    getConfigMock.mockResolvedValue({
      installedTemplates: { auth: { schemaVersion: 3, installedAt: 'x' } },
      templateSettings: { DATA_DIR: '/mnt/data/stacks' },
      installedVariables: [{ varName: 'LLDAP_LDAP_PORT', value: '13890' }],
    });

    await reconcileHostFirewallOnBoot();

    expect(filteredPorts()).toEqual([13890]);
    // The teeth of the bug: the DEFAULT port must not be what gets filtered.
    // Pre-fix this rendered `elements = { 3890 }`, so the real 13890 answered
    // every device on the LAN while the rule looked healthy.
    expect(renderedRuleset()).not.toContain('elements = { 3890 }');
    expect(renderedRuleset()).toContain('elements = { 13890 }');
    expect(renderedRuleset()).toContain('tcp dport @on_box_only_ports jump on_box_gate');
  });

  it('installs and loads that ruleset on the host, so the rule is really live', async () => {
    getConfigMock.mockResolvedValue({
      installedTemplates: { auth: { schemaVersion: 3, installedAt: 'x' } },
      templateSettings: {},
      installedVariables: [{ varName: 'LLDAP_LDAP_PORT', value: '13890' }],
    });

    await reconcileHostFirewallOnBoot();

    const flat = argvCalls.map(a => a.join(' '));
    // Dry-run validated before anything goes live, then installed + loaded.
    expect(flat).toContain('sudo /usr/sbin/nft -c -f /tmp/servicebay-host-firewall.nft');
    expect(flat.some(c => c.includes('install') && c.includes('/etc/servicebay/host-firewall.nft'))).toBe(true);
    expect(flat).toContain('sudo systemctl restart servicebay-host-firewall.service');
  });

  it('a global Template Setting still outranks the operator-set value', async () => {
    getConfigMock.mockResolvedValue({
      installedTemplates: { auth: { schemaVersion: 3, installedAt: 'x' } },
      templateSettings: { LLDAP_LDAP_PORT: '4890' },
      installedVariables: [{ varName: 'LLDAP_LDAP_PORT', value: '13890' }],
    });

    await reconcileHostFirewallOnBoot();

    expect(filteredPorts()).toEqual([4890]);
  });

  it('falls back to the declared default when the operator never changed it', async () => {
    getConfigMock.mockResolvedValue({
      installedTemplates: { auth: { schemaVersion: 3, installedAt: 'x' } },
      templateSettings: {},
      installedVariables: [],
    });

    await reconcileHostFirewallOnBoot();

    expect(filteredPorts()).toEqual([3890]);
  });

  it('does not let an unrelated template\'s saved value leak into this one', async () => {
    // `installedVariables` is a flat box-wide map. A same-named variable
    // saved for a template that does NOT declare blockLanAccess must not
    // become a firewall rule.
    getConfigMock.mockResolvedValue({
      installedTemplates: { media: { schemaVersion: 6, installedAt: 'x' } },
      templateSettings: {},
      installedVariables: [{ varName: 'LLDAP_LDAP_PORT', value: '13890' }],
    });

    await reconcileHostFirewallOnBoot();

    // Nothing declares the flag → the whole filter comes down, and no
    // ruleset is rendered at all.
    expect(renderedRuleset()).toBe('');
  });
});
