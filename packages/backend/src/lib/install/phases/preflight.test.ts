/**
 * Pre-flight (#2742) — everything that must be true before the first pod is
 * deployed.
 *
 * The phase never patches the job; it returns a discriminated result the
 * runner turns into job status. So the two things worth asserting are the
 * *result* (ordered selection, `nothing-selected`, or a refusal message) and
 * the *lines* — because every step in here except the topo-sort and the
 * sentinel refusal is best-effort, and a step that fails quietly is what
 * makes an install lie about what it did.
 *
 * The topo-sort, the secret reuse and the tier parsing run for real; only the
 * box-facing edges are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DeployContext } from './context';
import type { JobInput } from '../jobStore';

const logMock = vi.fn<(jobId: string, line: string) => Promise<void>>();
vi.mock('./context', () => ({ log: (jobId: string, line: string) => logMock(jobId, line) }));

const reconcileLanIpMock = vi.fn();
vi.mock('@/lib/lanIp', () => ({ reconcileLanIp: (node: string) => reconcileLanIpMock(node) }));

const reconcileOrphansMock = vi.fn();
vi.mock('../reconcileOrphanContainers', () => ({
  reconcileOrphanContainers: (node: string | undefined) => reconcileOrphansMock(node),
}));

const syncRegistriesMock = vi.fn();
vi.mock('@/lib/registry', () => ({ syncRegistries: () => syncRegistriesMock() }));

const formatRegistrySyncLogMock = vi.fn<(summary: unknown) => string[]>();
vi.mock('@/lib/registrySyncState', () => ({
  formatRegistrySyncLog: (summary: unknown) => formatRegistrySyncLogMock(summary),
}));

const refreshArtifactsMock = vi.fn();
const applyVariableDefaultsMock = vi.fn();
vi.mock('../manifestAssembler', () => ({
  refreshTemplateArtifacts: (items: unknown, source: string) => refreshArtifactsMock(items, source),
  applyVariableDefaults: (input: unknown, source: string) => applyVariableDefaultsMock(input, source),
}));

const getConfigMock = vi.fn();
vi.mock('@/lib/config', () => ({ getConfig: () => getConfigMock() }));

const loadSavedSecretsMock = vi.fn<(cfg: unknown) => Record<string, string>>();
vi.mock('../savedSecrets', () => ({ loadSavedSecrets: (cfg: unknown) => loadSavedSecretsMock(cfg) }));

const loadSavedVariablesMock = vi.fn();
const findUnrecoveredMock = vi.fn<(vars: unknown, saved: unknown) => string[]>();
vi.mock('../savedVariables', () => ({
  loadSavedVariables: (cfg: unknown) => loadSavedVariablesMock(cfg),
  findUnrecoveredVariables: (vars: unknown, saved: unknown) => findUnrecoveredMock(vars, saved),
  buildUnrecoveredVariablesWarning: (lost: string[]) => `⚠️ unrecovered: ${lost.join(', ')}`,
}));

const snapshotMock = vi.fn();
vi.mock('@/lib/store/repository', () => ({ getStoreSnapshot: () => snapshotMock() }));

const stateSelfHealMock = vi.fn();
vi.mock('./stateSelfHeal', () => ({
  runStateSelfHeal: (...args: unknown[]) => stateSelfHealMock(...args),
}));

const prePullMock = vi.fn();
vi.mock('./prePull', () => ({ runPrePullPhase: (...args: unknown[]) => prePullMock(...args) }));

import { runPreflightPhase } from './preflight';

const podYaml = (name: string, tier?: string) => [
  'apiVersion: v1',
  'kind: Pod',
  'metadata:',
  `  name: ${name}`,
  ...(tier ? ['  annotations:', `    servicebay.tier: "${tier}"`] : []),
  'spec:',
  '  containers: []',
].join('\n');

const input = (over: Partial<JobInput> = {}): JobInput => ({
  items: [],
  variables: [],
  templateSource: 'Built-in',
  host: 'servicebay.local',
  ...over,
});

const ctx = (over: Partial<JobInput> = {}): DeployContext => ({
  jobId: 'job1',
  input: input(over),
  scriptCredentials: [],
  deployed: [],
  reusedSecretNames: new Set<string>(),
});

const lines = () => logMock.mock.calls.map(c => c[1]);

beforeEach(() => {
  logMock.mockReset().mockResolvedValue(undefined);
  reconcileLanIpMock.mockReset().mockResolvedValue('192.168.1.50');
  reconcileOrphansMock.mockReset().mockResolvedValue({ removed: [], failed: [] });
  syncRegistriesMock.mockReset().mockResolvedValue({ registries: [] });
  formatRegistrySyncLogMock.mockReset().mockReturnValue([]);
  refreshArtifactsMock.mockReset().mockResolvedValue({ updated: [], unresolved: [] });
  applyVariableDefaultsMock.mockReset();
  getConfigMock.mockReset().mockResolvedValue({});
  loadSavedSecretsMock.mockReset().mockReturnValue({});
  loadSavedVariablesMock.mockReset().mockReturnValue({});
  findUnrecoveredMock.mockReset().mockReturnValue([]);
  snapshotMock.mockReset().mockReturnValue({ nodes: {} });
  stateSelfHealMock.mockReset().mockResolvedValue(undefined);
  prePullMock.mockReset().mockResolvedValue(undefined);
});

describe('runPreflightPhase — the ordered selection', () => {
  it('orders infrastructure ahead of features and hands the set to the heals + pre-pull', async () => {
    const c = ctx({
      items: [
        { name: 'media', checked: true, yaml: podYaml('media'), dependencies: ['auth'] },
        { name: 'auth', checked: true, yaml: podYaml('auth', 'infrastructure') },
        { name: 'skipped', checked: false, yaml: podYaml('skipped') },
      ],
    });

    const result = await runPreflightPhase(c);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.selected.map(s => s.name)).toEqual(['auth', 'media']);
    expect(result.selected[0].tier).toBe('infrastructure');
    // The re-ordering is announced, because the operator picked a different order.
    expect(lines()).toContain('Install order (by dependencies): auth → media');
    expect(stateSelfHealMock).toHaveBeenCalledWith('job1', c.input, result.selected, c.reusedSecretNames);
    expect(prePullMock).toHaveBeenCalledWith('job1', c.input, result.selected);
  });

  it('stays quiet about ordering when the operator’s order already worked', async () => {
    const result = await runPreflightPhase(ctx({
      items: [{ name: 'auth', checked: true, yaml: podYaml('auth') }],
    }));
    expect(result.ok).toBe(true);
    expect(lines().some(l => l.startsWith('Install order'))).toBe(false);
  });

  it('ends the run before it starts when nothing is selected', async () => {
    const result = await runPreflightPhase(ctx({ items: [{ name: 'media', checked: false }] }));
    expect(result).toEqual({ ok: false, kind: 'nothing-selected' });
    expect(lines()).toContain('⚠️ No services selected to install — aborting.');
    // Nothing further ran — no registry sync, no heals, no pulls.
    expect(syncRegistriesMock).not.toHaveBeenCalled();
    expect(prePullMock).not.toHaveBeenCalled();
  });

  it('refuses with an actionable message when a dependency is not selected', async () => {
    const result = await runPreflightPhase(ctx({
      items: [{ name: 'media', checked: true, yaml: podYaml('media'), dependencies: ['auth'] }],
    }));

    expect(result).toEqual({
      ok: false,
      kind: 'error',
      message: 'Cannot install media: it depends on auth, which is not selected. Go back and check that template, or unselect media.',
    });
    expect(prePullMock).not.toHaveBeenCalled();
  });

  it('counts a service already running on the node as a satisfied dependency', async () => {
    // Installing `media` must not be blocked on `auth` just because auth
    // wasn't re-checked in this batch.
    snapshotMock.mockReturnValue({ nodes: { Local: { services: [{ name: 'auth' }] } } });

    const result = await runPreflightPhase(ctx({
      items: [{ name: 'media', checked: true, yaml: podYaml('media'), dependencies: ['auth'] }],
    }));

    expect(result.ok).toBe(true);
  });

  it('names the cycle as a template-authoring bug', async () => {
    const result = await runPreflightPhase(ctx({
      items: [
        { name: 'a', checked: true, yaml: podYaml('a'), dependencies: ['b'] },
        { name: 'b', checked: true, yaml: podYaml('b'), dependencies: ['a'] },
      ],
    }));

    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== 'error') return;
    expect(result.message).toMatch(/dependency cycle \(a ↔ b\)\. This is a template-authoring bug/);
  });
});

describe('the LAN IP capture (#660)', () => {
  const oneItem = { items: [{ name: 'auth', checked: true, yaml: podYaml('auth') }] };

  it('publishes the captured IP as a LAN_IP template variable', async () => {
    const c = ctx(oneItem);
    await runPreflightPhase(c);
    expect(reconcileLanIpMock).toHaveBeenCalledWith('Local');
    expect(lines()[0]).toBe('Captured LAN IP: 192.168.1.50');
    expect(c.input.variables).toContainEqual({ name: 'LAN_IP', value: '192.168.1.50', global: true });
  });

  it('overwrites an existing blank LAN_IP rather than adding a second one', async () => {
    const c = ctx({ ...oneItem, variables: [{ name: 'LAN_IP', value: '' }] });
    await runPreflightPhase(c);
    expect(c.input.variables).toEqual([{ name: 'LAN_IP', value: '192.168.1.50' }]);
  });

  it('warns that the diagnose probes will degrade when the IP cannot be detected', async () => {
    reconcileLanIpMock.mockResolvedValue(null);
    const c = ctx(oneItem);
    await runPreflightPhase(c);
    expect(lines()[0]).toContain('Could not detect LAN IP');
    expect(c.input.variables).toEqual([]);
  });

  it('does not block the install when the capture throws', async () => {
    reconcileLanIpMock.mockRejectedValue(new Error('agent offline'));
    const result = await runPreflightPhase(ctx(oneItem));
    expect(lines()[0]).toBe('⚠️ LAN IP capture failed: agent offline');
    expect(result.ok).toBe(true);
  });
});

describe('the orphan-container reconcile (#1668)', () => {
  const oneItem = { items: [{ name: 'auth', checked: true, yaml: podYaml('auth') }] };

  it('reports what it removed and what it could not', async () => {
    reconcileOrphansMock.mockResolvedValue({ removed: ['ghost-a'], failed: [{ name: 'ghost-b' }] });
    await runPreflightPhase(ctx(oneItem));
    expect(lines()).toContain('Reconciled 1 orphan container record(s) from preserved storage: ghost-a');
    expect(lines()).toContain('⚠️ 1 orphan container(s) could not be removed: ghost-b');
  });

  it('says nothing when there was nothing to reconcile', async () => {
    await runPreflightPhase(ctx(oneItem));
    expect(lines().some(l => l.includes('orphan container'))).toBe(false);
  });

  it('notes a reconcile failure and continues', async () => {
    reconcileOrphansMock.mockRejectedValue(new Error('podman db locked'));
    const result = await runPreflightPhase(ctx(oneItem));
    expect(lines()).toContain('(note) orphan-container reconcile skipped: podman db locked');
    expect(result.ok).toBe(true);
  });
});

describe('the registry refresh + spec re-read (#1806/#2530/#2610)', () => {
  const oneItem = { items: [{ name: 'auth', checked: true, yaml: podYaml('auth') }] };

  it('logs exactly what the per-registry sync summary said — never a blanket claim', async () => {
    // #2610: the old line claimed "Refreshed external registries" whether two
    // of two, one of two or none of them actually refreshed.
    const summary = { registries: [{ name: 'r1', ok: true }] };
    syncRegistriesMock.mockResolvedValue(summary);
    formatRegistrySyncLogMock.mockReturnValue(['🔄 1/2 registries refreshed', '⚠️ r2 could not be cloned']);

    await runPreflightPhase(ctx(oneItem));

    expect(formatRegistrySyncLogMock).toHaveBeenCalledWith(summary);
    expect(lines()).toContain('🔄 1/2 registries refreshed');
    expect(lines()).toContain('⚠️ r2 could not be cloned');
  });

  it('installs from the existing clone when the sync fails, and says so', async () => {
    syncRegistriesMock.mockRejectedValue(new Error('network unreachable'));
    const result = await runPreflightPhase(ctx(oneItem));
    expect(lines()).toContain('⚠️ Registry refresh failed (network unreachable); installing from the existing on-disk clone.');
    expect(result.ok).toBe(true);
  });

  it('re-reads changed specs and re-applies defaults so a new variable ref is not rendered empty', async () => {
    refreshArtifactsMock.mockResolvedValue({ updated: ['auth'], unresolved: [] });
    applyVariableDefaultsMock.mockResolvedValue({ variables: [{ name: 'NEW_VAR', value: 'default' }] });
    const c = ctx(oneItem);

    await runPreflightPhase(c);

    expect(lines().some(l => l.includes('Re-read 1 template spec from the refreshed registry — auth changed'))).toBe(true);
    expect(c.input.variables).toEqual([{ name: 'NEW_VAR', value: 'default' }]);
  });

  it('warns that a spec it could not re-read may be out of date', async () => {
    refreshArtifactsMock.mockResolvedValue({ updated: [], unresolved: ['auth'] });
    await runPreflightPhase(ctx(oneItem));
    expect(lines().some(l => l.includes('Could not re-read the template spec for auth from any registry'))).toBe(true);
  });

  it('never fails the install on the re-read, but never lets it fail quietly either', async () => {
    refreshArtifactsMock.mockRejectedValue(new Error('registry clone corrupt'));
    const result = await runPreflightPhase(ctx(oneItem));
    expect(lines().some(l => l.includes('Could not re-read template specs from the registry (registry clone corrupt)'))).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe('the saved-secret reuse (#615/#2296/#2574)', () => {
  const secretVar = (name: string, value: string, explicit?: boolean) =>
    ({ name, value, explicit, meta: { type: 'secret' } });
  const withSecret = (value: string, explicit?: boolean) => ({
    items: [{ name: 'auth', checked: true, yaml: podYaml('auth') }],
    variables: [secretVar('LLDAP_ADMIN_PASSWORD', value, explicit)],
  });

  it('puts the saved secret back and records the reuse for the downstream self-heals', async () => {
    loadSavedSecretsMock.mockReturnValue({ LLDAP_ADMIN_PASSWORD: 'from-before' });
    const c = ctx(withSecret('wizard-generated'));

    await runPreflightPhase(c);

    expect(c.input.variables[0].value).toBe('from-before');
    expect(c.reusedSecretNames.has('LLDAP_ADMIN_PASSWORD')).toBe(true);
    expect(lines().some(l => l.includes('🔑 Reusing 1 saved secret from before the reset (LLDAP_ADMIN_PASSWORD)'))).toBe(true);
  });

  it('lets an explicitly supplied value rotate the saved one, and says what that costs', async () => {
    loadSavedSecretsMock.mockReturnValue({ LLDAP_ADMIN_PASSWORD: 'from-before' });
    const c = ctx(withSecret('operator-typed', true));

    await runPreflightPhase(c);

    expect(c.input.variables[0].value).toBe('operator-typed');
    // A rotated key must NOT count as reused — the Authelia heal keys off it.
    expect(c.reusedSecretNames.has('LLDAP_ADMIN_PASSWORD')).toBe(false);
    expect(lines().some(l => l.startsWith('🔁 Applying the value you supplied'))).toBe(true);
  });

  it('restores the stored secret behind a re-sent redaction mask', async () => {
    loadSavedSecretsMock.mockReturnValue({ LLDAP_ADMIN_PASSWORD: 'real-secret' });
    const c = ctx(withSecret('<redacted>'));

    const result = await runPreflightPhase(c);

    expect(result.ok).toBe(true);
    expect(c.input.variables[0].value).toBe('real-secret');
    expect(lines().some(l => l.includes("Ignored the masked value '<redacted>'"))).toBe(true);
  });

  it('refuses the run when a masked secret has nothing to fall back on (#2296)', async () => {
    loadSavedSecretsMock.mockReturnValue({});
    const c = ctx(withSecret('<redacted>'));

    const result = await runPreflightPhase(c);

    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== 'error') return;
    expect(result.message).toMatch(/^Refusing to deploy: secret variable\(s\) were supplied as the redaction mask/);
    expect(lines().at(-1)).toBe(`❌ ${result.message}`);
    // The refusal stops the run before the heals touch the box.
    expect(stateSelfHealMock).not.toHaveBeenCalled();
    expect(prePullMock).not.toHaveBeenCalled();
  });

  it('continues with the wizard values when the saved secrets cannot be read', async () => {
    loadSavedSecretsMock.mockImplementation(() => { throw new Error('secret.key missing'); });
    const result = await runPreflightPhase(ctx(withSecret('wizard-generated')));
    expect(lines().some(l => l.includes('(note) could not load saved secrets: secret.key missing'))).toBe(true);
    expect(result.ok).toBe(true);
  });
});

describe('the unrecovered-variable backstop (#2531)', () => {
  const oneItem = { items: [{ name: 'auth', checked: true, yaml: podYaml('auth') }] };

  it('gets its own loud line — a destroyed value is not a blank field', async () => {
    findUnrecoveredMock.mockReturnValue(['IMMICH_ADMIN_EMAIL']);
    await runPreflightPhase(ctx(oneItem));
    expect(lines()).toContain('⚠️ unrecovered: IMMICH_ADMIN_EMAIL');
  });

  it('is silent, and harmless, when the config cannot be read', async () => {
    findUnrecoveredMock.mockImplementation(() => { throw new Error('config unreadable'); });
    const result = await runPreflightPhase(ctx(oneItem));
    expect(result.ok).toBe(true);
    expect(lines().some(l => l.includes('unrecovered'))).toBe(false);
  });
});
