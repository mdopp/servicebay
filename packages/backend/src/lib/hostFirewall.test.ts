/**
 * Host-firewall render + apply tests (#2388).
 *
 * This module writes host firewall state, so the tests are deliberately
 * paranoid about the two ways it could hurt someone:
 *
 *   - **Over-reach.** Every rendered rule must be port-scoped, and the
 *     never-filter list must actually refuse SSH / proxy / ServiceBay
 *     ports. A rule that drops more than the declared port is a lockout.
 *   - **Stale state.** Uninstall must take the whole thing down, and a
 *     re-run must converge rather than stack rules — a firewall rule
 *     outliving its service is the other failure mode.
 *
 * The rendered ruleset and unit in the snapshot-ish assertions below were
 * validated against the real box: `nft -c -f` (dry run) and
 * `systemd-analyze verify` both exit 0 on nftables 1.1.6 / systemd 258
 * (Fedora CoreOS 44).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  collectLanBlockedPorts,
  renderNftRuleset,
  renderUnit,
  reconcileHostFirewall,
  removeHostFirewall,
  NEVER_FILTER_PORTS,
  NFT_TABLE,
  UNIT_NAME,
} from './hostFirewall';
import type { Executor } from './interfaces';

/** Minimal Executor stub recording every call. */
function fakeExecutor(opts: { failArgv?: RegExp; unitExists?: boolean; tableExists?: boolean } = {}) {
  const argvCalls: string[][] = [];
  const writes: Record<string, string> = {};
  const executor = {
    execArgv: vi.fn(async (argv: string[]) => {
      argvCalls.push(argv);
      const joined = argv.join(' ');
      if (joined === 'sh -c command -v nft') return { stdout: '/usr/sbin/nft\n', stderr: '' };
      if (/nft list table/.test(joined) && opts.tableExists !== true) throw new Error('No such file or directory');
      if (opts.failArgv?.test(joined)) throw new Error(`boom: ${joined}`);
      return { stdout: '', stderr: '' };
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      writes[path] = content;
    }),
    exists: vi.fn(async () => opts.unitExists ?? false),
  } as unknown as Executor;
  return { executor, argvCalls, writes };
}

const joined = (calls: string[][]) => calls.map(c => c.join(' '));

describe('collectLanBlockedPorts (#2388)', () => {
  it('collects a port a template flagged, resolving the value from config', () => {
    const plan = collectLanBlockedPorts({
      installedTemplates: ['auth', 'media'],
      declarations: {
        auth: { LLDAP_LDAP_PORT: { blockLanAccess: true, default: '3890' }, LLDAP_PORT: { default: '17170' } },
        media: { JELLYFIN_PORT: { default: '8096' } },
      },
      values: { LLDAP_LDAP_PORT: '3891' },
    });
    expect(plan).toEqual({ ports: [3891], skipped: [] });
  });

  it('falls back to the declared default when the value was never persisted', () => {
    // The live box's `templateSettings` genuinely does NOT carry
    // LLDAP_LDAP_PORT (it is a templates/settings.json global that was
    // never overridden), so the default IS the operative value there.
    const plan = collectLanBlockedPorts({
      installedTemplates: ['auth'],
      declarations: { auth: { LLDAP_LDAP_PORT: { blockLanAccess: true, default: '3890' } } },
      values: {},
    });
    expect(plan.ports).toEqual([3890]);
  });

  it('ignores every variable that did not opt in', () => {
    const plan = collectLanBlockedPorts({
      installedTemplates: ['auth'],
      declarations: {
        auth: {
          LLDAP_PORT: { default: '17170' },
          AUTHELIA_PORT: { blockLanAccess: false, default: '9091' },
        },
      },
      values: {},
    });
    expect(plan.ports).toEqual([]);
  });

  it('drops the template that is not installed', () => {
    const plan = collectLanBlockedPorts({
      installedTemplates: ['media'],
      declarations: { auth: { LLDAP_LDAP_PORT: { blockLanAccess: true, default: '3890' } } },
      values: {},
    });
    expect(plan.ports).toEqual([]);
  });

  it('de-duplicates and sorts so two templates declaring the same port render one element', () => {
    const plan = collectLanBlockedPorts({
      installedTemplates: ['auth', 'other'],
      declarations: {
        auth: { LLDAP_LDAP_PORT: { blockLanAccess: true, default: '3890' } },
        other: {
          ALSO_LDAP: { blockLanAccess: true, default: '3890' },
          THING: { blockLanAccess: true, default: '9999' },
        },
      },
      values: {},
    });
    expect(plan.ports).toEqual([3890, 9999]);
  });

  it.each(NEVER_FILTER_PORTS)('refuses to filter never-filter port %i', port => {
    const plan = collectLanBlockedPorts({
      installedTemplates: ['rogue'],
      declarations: { rogue: { SOME_PORT: { blockLanAccess: true, default: String(port) } } },
      values: {},
    });
    expect(plan.ports).toEqual([]);
    expect(plan.skipped[0]).toMatch(/never-filter list/);
  });

  it.each([
    ['unrendered mustache', '{{LLDAP_LDAP_PORT}}'],
    ['host:port', '0.0.0.0:3890'],
    ['empty', ''],
    ['out of range', '70000'],
    ['zero', '0'],
  ])('skips a %s value instead of guessing (%s)', (_label, raw) => {
    const plan = collectLanBlockedPorts({
      installedTemplates: ['auth'],
      declarations: { auth: { LLDAP_LDAP_PORT: { blockLanAccess: true, default: raw } } },
      values: {},
    });
    expect(plan.ports).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
  });

  it('skips a flagged variable with no value and no default at all', () => {
    const plan = collectLanBlockedPorts({
      installedTemplates: ['auth'],
      declarations: { auth: { MYSTERY_PORT: { blockLanAccess: true } } },
      values: {},
    });
    expect(plan.ports).toEqual([]);
    expect(plan.skipped[0]).toMatch(/not a plain port number/);
  });

  it('tolerates a template whose variables.json could not be read', () => {
    const plan = collectLanBlockedPorts({
      installedTemplates: ['auth', 'ghost'],
      declarations: {
        auth: { LLDAP_LDAP_PORT: { blockLanAccess: true, default: '3890' } },
        ghost: null,
      },
      values: {},
    });
    expect(plan.ports).toEqual([3890]);
  });
});

describe('renderNftRuleset (#2388)', () => {
  const ruleset = renderNftRuleset([3890]);

  it('puts exactly ONE rule in the hooked chain, and it is port-scoped', () => {
    // This is the structural safety property: a packet for any port
    // other than a declared one cannot reach a drop verdict, whatever
    // the gate chain says. If this assertion ever needs relaxing, the
    // lockout risk of the whole feature changes — re-read #2388 first.
    const base = ruleset.slice(ruleset.indexOf('chain input {'));
    const rules = base
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('chain') && l !== '}' && !l.startsWith('type filter'));
    expect(rules).toEqual(['tcp dport @on_box_only_ports jump on_box_gate']);
  });

  it('accepts the on-box paths before dropping — lo carries the pasta-proxied pod path', () => {
    const gate = ruleset.slice(ruleset.indexOf('chain on_box_gate'), ruleset.indexOf('chain input'));
    expect(gate.indexOf('iifname "lo" accept')).toBeGreaterThan(-1);
    expect(gate.indexOf('iifname "podman*" accept')).toBeGreaterThan(-1);
    // Order matters: an accept AFTER the drop would never be reached.
    expect(gate.indexOf('iifname "lo" accept')).toBeLessThan(gate.indexOf('counter drop'));
  });

  it('never flushes the ruleset — podman/netavark share the namespace', () => {
    expect(ruleset).not.toMatch(/flush ruleset/);
    // The distro's own nftables.service ExecStop does exactly that, which
    // is why we ship our own unit.
    expect(renderUnit('/usr/sbin/nft')).not.toMatch(/flush ruleset/);
  });

  it('only ever names its own table', () => {
    const tables = [...ruleset.matchAll(/table inet (\S+)/g)].map(m => m[1]);
    expect(new Set(tables)).toEqual(new Set([NFT_TABLE]));
  });

  it('is re-appliable in one transaction: add, delete, then re-add the table', () => {
    const order = ['add table inet', 'delete table inet', 'table inet servicebay_lanblock {'];
    let cursor = -1;
    for (const needle of order) {
      const at = ruleset.indexOf(needle, cursor + 1);
      expect(at, needle).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('carries the one-line emergency rollback in the file itself', () => {
    expect(ruleset).toContain(`sudo nft delete table inet ${NFT_TABLE}`);
  });

  it('renders every declared port into the set', () => {
    expect(renderNftRuleset([3890, 9999])).toContain('elements = { 3890, 9999 }');
  });

  it('refuses to render an empty ruleset (removal is a different code path)', () => {
    expect(() => renderNftRuleset([])).toThrow(/empty ruleset/);
  });
});

describe('renderUnit (#2388)', () => {
  it('loads our file on start and deletes only our table on stop', () => {
    const unit = renderUnit('/usr/bin/nft');
    expect(unit).toContain('ExecStart=/usr/bin/nft -f /etc/servicebay/host-firewall.nft');
    // The `-` prefix keeps `systemctl stop` a success after a manual
    // rollback already removed the table — that stop IS the rollback
    // handle, so it must not be able to fail.
    expect(unit).toContain(`ExecStop=-/usr/bin/nft delete table inet ${NFT_TABLE}`);
    expect(unit).toContain('RemainAfterExit=yes');
  });

  it('orders itself before the network comes up, so a reboot has no exposed window', () => {
    expect(renderUnit('/usr/sbin/nft')).toContain('Before=network-pre.target');
  });
});

describe('reconcileHostFirewall (#2388)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dry-runs the ruleset BEFORE anything becomes live', () => {
    // A syntax error must not be able to reach /etc (where the boot unit
    // would then fail to load it) or the kernel.
    const { executor, argvCalls } = fakeExecutor();
    return reconcileHostFirewall(executor, [3890]).then(() => {
      const calls = joined(argvCalls);
      const check = calls.findIndex(c => c.includes('nft -c -f'));
      const install = calls.findIndex(c => c.includes('install -m 0644'));
      const restart = calls.findIndex(c => c.includes(`systemctl restart ${UNIT_NAME}`));
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(install);
      expect(check).toBeLessThan(restart);
      expect(calls.find(c => c.includes('nft -c -f'))).toContain('/tmp/');
    });
  });

  it('aborts without touching /etc or the kernel when the dry run fails', async () => {
    const { executor, argvCalls } = fakeExecutor({ failArgv: /nft -c -f/ });
    await expect(reconcileHostFirewall(executor, [3890])).rejects.toThrow(/boom/);
    const calls = joined(argvCalls);
    expect(calls.some(c => c.includes('install -m 0644'))).toBe(false);
    expect(calls.some(c => c.includes('systemctl'))).toBe(false);
  });

  it('installs the ruleset + unit root-owned and restarts (not starts) the unit', async () => {
    const { executor, argvCalls, writes } = fakeExecutor();
    await reconcileHostFirewall(executor, [3890]);
    const calls = joined(argvCalls);
    expect(calls).toContain('sudo install -m 0644 -o root -g root /tmp/servicebay-host-firewall.nft /etc/servicebay/host-firewall.nft');
    expect(calls).toContain(`sudo install -m 0644 -o root -g root /tmp/servicebay-host-firewall.service /etc/systemd/system/${UNIT_NAME}`);
    expect(calls).toContain('sudo systemctl daemon-reload');
    expect(calls).toContain(`sudo systemctl enable ${UNIT_NAME}`);
    // `start` would be a no-op on a RemainAfterExit=yes unit that is
    // already active, leaving the kernel on the PREVIOUS port set.
    expect(calls).toContain(`sudo systemctl restart ${UNIT_NAME}`);
    expect(calls.some(c => c === `sudo systemctl start ${UNIT_NAME}`)).toBe(false);
    expect(writes['/tmp/servicebay-host-firewall.nft']).toContain('elements = { 3890 }');
  });

  it('is idempotent: two identical runs converge instead of stacking rules', async () => {
    const { executor, writes } = fakeExecutor({ unitExists: true, tableExists: true });
    await reconcileHostFirewall(executor, [3890]);
    const first = writes['/tmp/servicebay-host-firewall.nft'];
    await reconcileHostFirewall(executor, [3890]);
    expect(writes['/tmp/servicebay-host-firewall.nft']).toBe(first);
    // Rules can't accumulate because the file replaces the table wholesale.
    expect(first).toMatch(/delete table inet servicebay_lanblock/);
  });

  it('an empty port list means remove, not "render nothing"', async () => {
    const { executor, argvCalls } = fakeExecutor({ unitExists: true, tableExists: true });
    await reconcileHostFirewall(executor, []);
    const calls = joined(argvCalls);
    expect(calls).toContain(`sudo systemctl disable --now ${UNIT_NAME}`);
    expect(calls.some(c => c.includes('install -m 0644'))).toBe(false);
  });

  it('falls back to a known nft path when the probe cannot resolve one', async () => {
    const { executor, writes } = fakeExecutor();
    (executor.execArgv as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (argv: string[]) => {
      if (argv.join(' ') === 'sh -c command -v nft') throw new Error('no shell');
      return { stdout: '', stderr: '' };
    });
    await reconcileHostFirewall(executor, [3890]);
    expect(writes['/tmp/servicebay-host-firewall.service']).toContain('ExecStart=/usr/sbin/nft -f');
  });
});

describe('removeHostFirewall (#2388)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tears down unit, table and files — a rule must not outlive its service', async () => {
    const { executor, argvCalls } = fakeExecutor({ unitExists: true, tableExists: true });
    await removeHostFirewall(executor);
    const calls = joined(argvCalls);
    // disable --now runs ExecStop (which deletes the table); the explicit
    // delete is the belt-and-braces path for a table applied without the
    // unit ever being installed.
    expect(calls).toContain(`sudo systemctl disable --now ${UNIT_NAME}`);
    expect(calls).toContain(`sudo /usr/sbin/nft delete table inet ${NFT_TABLE}`);
    expect(calls).toContain(`sudo rm -f /etc/systemd/system/${UNIT_NAME} /etc/servicebay/host-firewall.nft`);
    expect(calls).toContain('sudo systemctl daemon-reload');
  });

  it('is quiet on a box that never had the filter', async () => {
    const { executor, argvCalls } = fakeExecutor({ unitExists: false, tableExists: false });
    await removeHostFirewall(executor);
    expect(joined(argvCalls).some(c => c.includes('systemctl'))).toBe(false);
  });

  it('still cleans up when the unit file is gone but the table is live', async () => {
    const { executor, argvCalls } = fakeExecutor({ unitExists: false, tableExists: true });
    await removeHostFirewall(executor);
    expect(joined(argvCalls)).toContain(`sudo /usr/sbin/nft delete table inet ${NFT_TABLE}`);
  });

  it('keeps going when a teardown step fails — every step tolerates already-gone', async () => {
    const { executor, argvCalls } = fakeExecutor({ unitExists: true, tableExists: true, failArgv: /systemctl disable/ });
    await expect(removeHostFirewall(executor)).resolves.toBeUndefined();
    expect(joined(argvCalls)).toContain(`sudo /usr/sbin/nft delete table inet ${NFT_TABLE}`);
  });
});
