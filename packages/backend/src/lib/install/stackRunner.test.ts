/**
 * Stack-runner tests (#633).
 *
 * Mocks the registry + twin so we drive the runner with deterministic
 * fixtures. The actual per-template deploy is supplied via the
 * `deployTemplate` callback in `StackInstallOptions` — tests stub it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StackManifest } from '@/lib/template/stackContract';
import type { DegradedCoreEntry } from './stackHealth';

const getStackManifestMock = vi.fn<(name: string) => Promise<StackManifest | null>>();
vi.mock('@/lib/registry', () => ({
  getStackManifest: (name: string) => getStackManifestMock(name),
}));

const twinStub: {
  nodes: Record<string, { services?: Array<{ name: string; health?: { ready: boolean; degraded?: boolean } }> }>;
} = { nodes: {} };
vi.mock('@/lib/store/twin', () => ({
  DigitalTwinStore: { getInstance: () => twinStub },
}));

// `getDegradedCoreSummary` walks the on-disk `stacks/` directory in
// real use. The tier-gate test cares about its return value, not its
// fs traversal, so we stub it. Default = no degraded core (gate passes).
const degradedCoreMock = vi.fn<() => Promise<DegradedCoreEntry[]>>().mockResolvedValue([]);
vi.mock('./stackHealth', async () => {
  const actual = await vi.importActual<typeof import('./stackHealth')>('./stackHealth');
  return {
    ...actual,
    getDegradedCoreSummary: () => degradedCoreMock(),
  };
});

import { installStack, preflightCrossStackDeps, prepareStackInstall } from './stackRunner';

const basic: StackManifest = {
  name: 'basic',
  label: 'Core',
  tier: 'core',
  lifecycle: 'atomic-wipe',
  dependsOnStacks: [],
  templates: ['nginx', 'auth', 'adguard'],
};

const immich: StackManifest = {
  name: 'immich',
  label: 'Immich',
  tier: 'feature',
  lifecycle: 'wipeable',
  dependsOnStacks: ['basic'],
  templates: ['immich'],
};

beforeEach(() => {
  getStackManifestMock.mockReset();
  twinStub.nodes = {};
  degradedCoreMock.mockReset();
  degradedCoreMock.mockResolvedValue([]);
});

function setNodeHealth(node: string, health: Record<string, boolean>): void {
  twinStub.nodes[node] = {
    services: Object.entries(health).map(([name, ready]) => ({
      name,
      health: { ready, lastCheckedAt: '' } as never,
    })),
  };
}

describe('preflightCrossStackDeps', () => {
  it('passes when stack has no deps', async () => {
    const r = await preflightCrossStackDeps(basic);
    expect(r.ok).toBe(true);
  });

  it('blocks when a depended-on stack has no manifest', async () => {
    getStackManifestMock.mockResolvedValueOnce(null);
    const r = await preflightCrossStackDeps(immich);
    expect(r.ok).toBe(false);
    expect(r.blockedBy[0].stack).toBe('basic');
    expect(r.blockedBy[0].health).toBeNull();
  });

  it('blocks when a depended-on stack is unhealthy', async () => {
    getStackManifestMock.mockResolvedValueOnce(basic);
    setNodeHealth('Local', { nginx: true, auth: false, adguard: true });
    const r = await preflightCrossStackDeps(immich);
    expect(r.ok).toBe(false);
    expect(r.blockedBy[0].health?.ready).toBe(false);
  });

  it('passes when every depended-on stack is fully ready', async () => {
    getStackManifestMock.mockResolvedValueOnce(basic);
    setNodeHealth('Local', { nginx: true, auth: true, adguard: true });
    const r = await preflightCrossStackDeps(immich);
    expect(r.ok).toBe(true);
  });
});

describe('prepareStackInstall', () => {
  function tmpl(name: string, deps: string[]): string {
    return `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  annotations:
    servicebay.label: "${name}"
${deps.length > 0 ? `    servicebay.dependencies: "${deps.join(',')}"` : ''}
spec:
  containers: []
`;
  }

  it('orders templates by their per-template dependencies', async () => {
    getStackManifestMock.mockResolvedValueOnce(basic);
    const load = vi.fn(async (n: string) => {
      // adguard depends on nginx + auth; auth depends on nginx; nginx no deps.
      // Topo order should be nginx → auth → adguard.
      if (n === 'nginx') return tmpl('nginx', []);
      if (n === 'auth') return tmpl('auth', ['nginx']);
      if (n === 'adguard') return tmpl('adguard', ['nginx', 'auth']);
      return null;
    });
    const r = await prepareStackInstall('basic', new Set(), load);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.order).toEqual(['nginx', 'auth', 'adguard']);
  });

  it('skips templates that are already healthy', async () => {
    getStackManifestMock.mockResolvedValueOnce(basic);
    const load = vi.fn(async (n: string) => {
      if (n === 'nginx') return tmpl('nginx', []);
      if (n === 'auth') return tmpl('auth', ['nginx']);
      if (n === 'adguard') return tmpl('adguard', ['nginx']);
      return null;
    });
    const r = await prepareStackInstall('basic', new Set(['nginx']), load);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.order).toEqual(['auth', 'adguard']);
    expect(r.plan.status.nginx).toBe('already-installed');
    expect(r.plan.status.auth).toBe('pending');
  });

  it('returns an error when a template references a non-existent template', async () => {
    getStackManifestMock.mockResolvedValueOnce(basic);
    const r = await prepareStackInstall('basic', new Set(), async () => null);
    expect(r.ok).toBe(false);
  });

  it('returns an error when manifest is missing', async () => {
    getStackManifestMock.mockResolvedValueOnce(null);
    const r = await prepareStackInstall('ghost', new Set(), async () => null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/has no manifest/);
  });
});

describe('installStack', () => {
  function makeOpts(overrides: {
    deployedSet?: Set<string>;
    deploys?: Record<string, { ok: true } | { ok: false; error: string }>;
  } = {}) {
    const events: unknown[] = [];
    return {
      events,
      opts: {
        loadTemplateYaml: async (n: string) =>
          `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${n}\n  annotations:\n    servicebay.label: "${n}"\nspec:\n  containers: []\n`,
        getReadyTemplates: async () => overrides.deployedSet ?? new Set<string>(),
        deployTemplate: async (t: string) => {
          return overrides.deploys?.[t] ?? { ok: true };
        },
        onProgress: (e: unknown) => events.push(e),
      },
    };
  }

  it('refuses to install when a cross-stack dep is missing', async () => {
    getStackManifestMock.mockResolvedValueOnce(immich); // outer call
    getStackManifestMock.mockResolvedValueOnce(null);   // basic is missing
    const { opts, events } = makeOpts();
    const r = await installStack('immich', opts);
    expect(r.ok).toBe(false);
    expect(events.some(e => (e as { kind?: string }).kind === 'preflight-failed')).toBe(true);
  });

  it('topo-installs templates in order on the happy path', async () => {
    getStackManifestMock.mockResolvedValueOnce(basic); // installStack outer
    getStackManifestMock.mockResolvedValueOnce(basic); // prepareStackInstall
    const { opts, events } = makeOpts();
    const r = await installStack('basic', opts);
    expect(r.ok).toBe(true);
    const starts = events.filter(e => (e as { kind?: string }).kind === 'template-start') as Array<{ template: string }>;
    expect(starts.map(s => s.template)).toEqual(['nginx', 'auth', 'adguard']);
    expect(events.at(-1)).toMatchObject({ kind: 'stack-ok' });
  });

  it('stops at the failing template and reports stack-partial', async () => {
    getStackManifestMock.mockResolvedValueOnce(basic);
    getStackManifestMock.mockResolvedValueOnce(basic);
    const { opts, events } = makeOpts({
      deploys: { auth: { ok: false, error: 'auth crashed' } },
    });
    const r = await installStack('basic', opts);
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe('auth');
    const starts = events.filter(e => (e as { kind?: string }).kind === 'template-start') as Array<{ template: string }>;
    // nginx ran (deploy ok), auth ran (failed). adguard never started.
    expect(starts.map(s => s.template)).toEqual(['nginx', 'auth']);
    expect(events.at(-1)).toMatchObject({ kind: 'stack-partial', failed: 'auth' });
  });

  it('skips already-healthy templates and resumes from the first pending', async () => {
    getStackManifestMock.mockResolvedValueOnce(basic);
    getStackManifestMock.mockResolvedValueOnce(basic);
    const { opts, events } = makeOpts({
      deployedSet: new Set(['nginx']),
    });
    const r = await installStack('basic', opts);
    expect(r.ok).toBe(true);
    const starts = events.filter(e => (e as { kind?: string }).kind === 'template-start') as Array<{ template: string }>;
    // nginx already-installed → skipped; deploy fires for auth, adguard.
    expect(starts.map(s => s.template)).toEqual(['auth', 'adguard']);
  });
});

describe('installStack — tier gate (#635 / Phase 5C)', () => {
  function makeOpts() {
    const events: unknown[] = [];
    return {
      events,
      opts: {
        loadTemplateYaml: async (n: string) =>
          `apiVersion: v1\nkind: Pod\nmetadata:\n  name: ${n}\n  annotations:\n    servicebay.label: "${n}"\nspec:\n  containers: []\n`,
        getReadyTemplates: async () => new Set<string>(),
        deployTemplate: async () => ({ ok: true as const }),
        onProgress: (e: unknown) => events.push(e),
      },
    };
  }

  it('refuses feature-stack install when any core stack is degraded', async () => {
    getStackManifestMock.mockResolvedValue(immich);
    degradedCoreMock.mockResolvedValueOnce([
      { stack: 'basic', label: 'Core services', notReady: [{ template: 'auth', state: 'unhealthy' }] },
    ]);
    const { opts, events } = makeOpts();
    const r = await installStack('immich', opts);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/core not ready/);
    expect(r.error).toMatch(/auth\(unhealthy\)/);
    const gate = events.find(e => (e as { kind?: string }).kind === 'tier-gate-failed') as { degraded: DegradedCoreEntry[] };
    expect(gate.degraded).toHaveLength(1);
  });

  it('allows feature-stack install when core is healthy', async () => {
    const basicCore: StackManifest = {
      name: 'basic', label: 'Core', tier: 'core', lifecycle: 'atomic-wipe',
      dependsOnStacks: [], templates: ['nginx'],
    };
    // Use mockImplementation so multiple lookups (installStack, preflight
    // → getStackHealth → getStackManifest('basic'), prepareStackInstall)
    // all resolve correctly by name.
    getStackManifestMock.mockImplementation(async (name: string) => {
      if (name === 'immich') return immich;
      if (name === 'basic') return basicCore;
      return null;
    });
    twinStub.nodes['Local'] = {
      services: [{ name: 'nginx', health: { ready: true } }],
    };
    degradedCoreMock.mockResolvedValueOnce([]);
    const r = await installStack('immich', makeOpts().opts);
    expect(r.ok).toBe(true);
  });

  it('does NOT gate a tier=core stack on itself (core install can fix core)', async () => {
    // `basic` is tier:core; even if it reports as degraded (because
    // it's not installed yet), installing it must not refuse on the
    // tier gate — that's the install path that would fix the
    // problem.
    getStackManifestMock.mockResolvedValueOnce(basic);
    getStackManifestMock.mockResolvedValueOnce(basic);
    degradedCoreMock.mockResolvedValueOnce([
      { stack: 'basic', label: 'Core', notReady: [{ template: 'nginx', state: 'unknown' }] },
    ]);
    const r = await installStack('basic', makeOpts().opts);
    expect(r.ok).toBe(true);
  });
});
