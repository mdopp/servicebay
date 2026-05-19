/**
 * Stack-runner tests (#633).
 *
 * Mocks the registry + twin so we drive the runner with deterministic
 * fixtures. The actual per-template deploy is supplied via the
 * `deployTemplate` callback in `StackInstallOptions` — tests stub it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StackManifest } from '@/lib/template/stackContract';

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
