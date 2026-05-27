import { describe, it, expect, vi, beforeEach } from 'vitest';
import yaml from 'js-yaml';

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
}));
vi.mock('@/lib/store/twin', () => ({
  DigitalTwinStore: { getInstance: () => ({ nodes: {} }) },
}));
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: {
    listServices: vi.fn(),
    getServiceFiles: vi.fn(),
    restartService: vi.fn(),
  },
}));
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: vi.fn() },
}));
vi.mock('@/lib/health/domainChecks', () => ({ syncDomainChecks: vi.fn() }));
vi.mock('@/lib/health/dnsRoutingChecks', () => ({ syncDnsRoutingChecks: vi.fn() }));

import { getConfig, updateConfig } from '@/lib/config';
import {
  applyMigrationToPublic,
  planMigrationToPublic,
  validatePublicDomain,
  type MigrationDeps,
} from '@/lib/reverseProxy/migrateToPublic';

/**
 * End-to-end tests for the LAN→Public migration orchestrator. We pass
 * an in-memory `MigrationDeps` so the real NPM + Authelia + health
 * paths stay untouched — keeps the test surface focused on the
 * orchestration logic (plan ordering, step skipping, idempotence,
 * error containment).
 */

const LAN_ROOT = 'home.arpa';
const PUBLIC_DOMAIN = 'dopp.cloud';

const SAMPLE_AUTHELIA = `
session:
  secret: 's3cret'
  cookies:
    - domain: 'home.arpa'
      authelia_url: 'https://auth.home.arpa'
identity_providers:
  oidc:
    clients:
      - client_id: 'servicebay'
        redirect_uris:
          - 'https://admin.home.arpa/api/auth/oidc/callback'
`;

interface FakeHost {
  id: number;
  domain_names: string[];
  certificate_id?: number;
}

function makeDeps(opts: {
  hosts?: FakeHost[];
  autheliaContent?: string | null;
  npmAvailable?: boolean;
  failApplyHost?: number;
  failApplyAuthelia?: boolean;
  failApplyCertFor?: string;
}): { deps: MigrationDeps; spies: { updateHost: ReturnType<typeof vi.fn>; writeConfig: ReturnType<typeof vi.fn>; requestCert: ReturnType<typeof vi.fn>; bindCert: ReturnType<typeof vi.fn>; restartAuth: ReturnType<typeof vi.fn>; syncChecks: ReturnType<typeof vi.fn> } } {
  const npmTarget = opts.npmAvailable === false
    ? null
    : { apiUrl: 'http://npm:81', nodeName: 'Local', nodeIp: '10.0.0.1' };
  const hosts = (opts.hosts ?? []).map(h => ({ ...h, domain_names: h.domain_names.slice() }));

  const updateHost = vi.fn(async (_url: string, _t: string, id: number, patch: { domain_names?: string[]; certificate_id?: number }) => {
    if (opts.failApplyHost === id && patch.domain_names) throw new Error(`forced update-host failure for ${id}`);
    const host = hosts.find(h => h.id === id);
    if (!host) throw new Error(`host ${id} not found`);
    if (patch.domain_names) host.domain_names = patch.domain_names.slice();
    if (typeof patch.certificate_id === 'number') host.certificate_id = patch.certificate_id;
  });
  const writeConfig = vi.fn<(node: string, path: string, content: string) => Promise<undefined>>(async () => undefined);
  const requestCert = vi.fn(async (_url: string, _t: string, domain: string) => {
    if (opts.failApplyCertFor === domain) throw new Error(`forced cert-request failure for ${domain}`);
    return 999 + Math.floor(Math.random() * 100);
  });
  const bindCert = vi.fn(async (_url: string, _t: string, hostId: number, certId: number) => {
    const host = hosts.find(h => h.id === hostId);
    if (host) host.certificate_id = certId;
  });
  const restartAuth = vi.fn(async () => {
    if (opts.failApplyAuthelia) throw new Error('forced restart failure');
  });
  const syncChecks = vi.fn(async () => undefined);

  return {
    deps: {
      npm: {
        resolveNpm: async () => npmTarget,
        getToken: async () => (npmTarget ? 'tok' : null),
        listHosts: async () => hosts,
        updateHost,
        requestCert,
        bindCert,
      },
      authelia: {
        locateConfig: async () => {
          if (opts.autheliaContent === null) return null;
          return {
            node: 'Local',
            path: '/etc/authelia/configuration.yml',
            content: opts.autheliaContent ?? SAMPLE_AUTHELIA,
          };
        },
        writeConfig: async (node, path, content) => {
          await writeConfig(node, path, content);
          if (opts.failApplyAuthelia) throw new Error('forced write failure');
        },
        restartAuth,
      },
      health: { syncChecks },
    },
    spies: { updateHost, writeConfig, requestCert, bindCert, restartAuth, syncChecks },
  };
}

beforeEach(() => {
  vi.mocked(getConfig).mockResolvedValue({
    reverseProxy: { lanDomain: LAN_ROOT, hosts: [] },
    autoUpdate: { enabled: false, schedule: '' },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(updateConfig).mockResolvedValue({} as any);
});

describe('validatePublicDomain', () => {
  it('accepts a well-formed hostname', () => {
    expect(validatePublicDomain('example.com')).toBeNull();
    expect(validatePublicDomain('sub.example.co.uk')).toBeNull();
  });

  it('rejects non-strings, empty strings, and shapes that aren\'t hostnames', () => {
    expect(validatePublicDomain(undefined)).toMatch(/string/);
    expect(validatePublicDomain('')).toMatch(/required/);
    expect(validatePublicDomain('not a domain')).toMatch(/hostname/);
    expect(validatePublicDomain('http://example.com')).toMatch(/hostname/);
  });
});

describe('planMigrationToPublic', () => {
  it('emits a dual-server_name step + cert-request step per lan-rooted host', async () => {
    const { deps } = makeDeps({
      hosts: [
        { id: 1, domain_names: ['vault.home.arpa'] },
        { id: 2, domain_names: ['immich.home.arpa'] },
      ],
    });
    const plan = await planMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: true }, deps);
    const dualSteps = plan.steps.filter(s => s.kind === 'npm-dual-server-name');
    const certSteps = plan.steps.filter(s => s.kind === 'cert-request');

    expect(dualSteps).toHaveLength(2);
    expect(certSteps).toHaveLength(2);

    expect((dualSteps[0] as { after: string[] }).after).toEqual(['vault.home.arpa', 'vault.dopp.cloud']);
    expect((certSteps[0] as { domain: string }).domain).toBe('vault.dopp.cloud');
  });

  it('marks dual-server_name as skipped when the host already carries the public twin', async () => {
    const { deps } = makeDeps({
      hosts: [{ id: 1, domain_names: ['vault.home.arpa', 'vault.dopp.cloud'] }],
    });
    const plan = await planMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: true }, deps);
    const dual = plan.steps.find(s => s.kind === 'npm-dual-server-name')!;
    expect((dual as { skipped: boolean }).skipped).toBe(true);
  });

  it('marks cert-request as skipped when the host already has a non-zero certificate_id', async () => {
    const { deps } = makeDeps({
      hosts: [{ id: 1, domain_names: ['vault.home.arpa'], certificate_id: 42 }],
    });
    const plan = await planMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: true }, deps);
    const cert = plan.steps.find(s => s.kind === 'cert-request')!;
    expect((cert as { skipped: boolean; skipReason?: string }).skipped).toBe(true);
    expect((cert as { skipReason?: string }).skipReason).toMatch(/certificate_id=42/);
  });

  it('emits an authelia-config step that captures the cookie + access-control + oidc changes', async () => {
    const { deps } = makeDeps({ hosts: [] });
    const plan = await planMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: true }, deps);
    const step = plan.steps.find(s => s.kind === 'authelia-config')!;
    const cast = step as { changes: { cookieDomain: { from: string | null; to: string }; oidcRedirectUriAdditions: { clientId: string; added: string[] }[] }; noop: boolean };
    expect(cast.changes.cookieDomain).toEqual({ from: 'home.arpa', to: PUBLIC_DOMAIN });
    expect(cast.changes.oidcRedirectUriAdditions[0].added).toEqual(['https://admin.dopp.cloud/api/auth/oidc/callback']);
    expect(cast.noop).toBe(false);
  });

  it('surfaces a warning + skips proxy steps when NPM is unavailable', async () => {
    const { deps } = makeDeps({ npmAvailable: false });
    const plan = await planMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: true }, deps);
    expect(plan.warnings.some(w => /Nginx Proxy Manager.*not deployed/i.test(w))).toBe(true);
    expect(plan.steps.find(s => s.kind === 'npm-dual-server-name')).toBeUndefined();
  });

  it('surfaces a warning + skips authelia step when the auth pod is absent', async () => {
    const { deps } = makeDeps({ hosts: [], autheliaContent: null });
    const plan = await planMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: true }, deps);
    expect(plan.warnings.some(w => /auth pod/i.test(w))).toBe(true);
    expect(plan.steps.find(s => s.kind === 'authelia-config')).toBeUndefined();
  });

  it('is deterministic across re-runs against the same input', async () => {
    const { deps: d1 } = makeDeps({ hosts: [{ id: 1, domain_names: ['vault.home.arpa'] }] });
    const { deps: d2 } = makeDeps({ hosts: [{ id: 1, domain_names: ['vault.home.arpa'] }] });
    const a = await planMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: true }, d1);
    const b = await planMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: true }, d2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('applyMigrationToPublic', () => {
  it('dry-run never invokes any write hook', async () => {
    const { deps, spies } = makeDeps({ hosts: [{ id: 1, domain_names: ['vault.home.arpa'] }] });
    const r = await applyMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: true }, deps);
    expect(r.applied).toBe(false);
    expect(spies.updateHost).not.toHaveBeenCalled();
    expect(spies.writeConfig).not.toHaveBeenCalled();
    expect(spies.requestCert).not.toHaveBeenCalled();
    expect(spies.restartAuth).not.toHaveBeenCalled();
    // All step results pass through ok.
    expect(r.stepResults.every(s => s.ok)).toBe(true);
  });

  it('apply: dual-server_name PUT, Authelia write+restart, cert request+bind, config persist + health resync', async () => {
    const { deps, spies } = makeDeps({ hosts: [{ id: 1, domain_names: ['vault.home.arpa'] }] });
    const r = await applyMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: false }, deps);
    expect(r.applied).toBe(true);
    expect(r.errors).toEqual([]);

    expect(spies.updateHost).toHaveBeenCalledWith('http://npm:81', 'tok', 1, { domain_names: ['vault.home.arpa', 'vault.dopp.cloud'] });
    expect(spies.writeConfig).toHaveBeenCalledTimes(1);
    expect(spies.restartAuth).toHaveBeenCalledTimes(1);
    expect(spies.requestCert).toHaveBeenCalledWith('http://npm:81', 'tok', 'vault.dopp.cloud');
    expect(spies.bindCert).toHaveBeenCalledTimes(1);
    expect(spies.syncChecks).toHaveBeenCalledTimes(1);

    // Authelia content actually flips the cookie domain.
    const written = vi.mocked(spies.writeConfig).mock.calls[0][2];
    const parsed = yaml.load(written) as { session: { cookies: { domain: string }[] } };
    expect(parsed.session.cookies[0].domain).toBe(PUBLIC_DOMAIN);

    // Config is persisted with the new publicDomain set.
    expect(updateConfig).toHaveBeenCalled();
    const persisted = vi.mocked(updateConfig).mock.calls[0][0] as { reverseProxy: { publicDomain: string } };
    expect(persisted.reverseProxy.publicDomain).toBe(PUBLIC_DOMAIN);
  });

  it('isolates a single step failure — other steps still run and the failure lands in errors[]', async () => {
    const { deps, spies } = makeDeps({
      hosts: [
        { id: 1, domain_names: ['vault.home.arpa'] },
        { id: 2, domain_names: ['immich.home.arpa'] },
      ],
      failApplyHost: 1,
    });
    const r = await applyMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: false }, deps);
    expect(r.applied).toBe(true);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].step).toBe('npm-dual-server-name');
    expect(r.errors[0].target).toBe('vault.home.arpa');
    // Host 2 still got dual-server_named.
    expect(spies.updateHost).toHaveBeenCalledWith('http://npm:81', 'tok', 2, { domain_names: ['immich.home.arpa', 'immich.dopp.cloud'] });
    // Authelia + cert + health steps still ran.
    expect(spies.restartAuth).toHaveBeenCalled();
    expect(spies.syncChecks).toHaveBeenCalled();
  });

  it('re-runs are idempotent — apply against already-migrated hosts is a no-op for those steps', async () => {
    const { deps, spies } = makeDeps({
      hosts: [{ id: 1, domain_names: ['vault.home.arpa', 'vault.dopp.cloud'], certificate_id: 7 }],
    });
    const r = await applyMigrationToPublic({ publicDomain: PUBLIC_DOMAIN, dryRun: false }, deps);
    expect(r.errors).toEqual([]);
    // Dual-server_name skipped → updateHost(domain_names) not invoked.
    const writeCalls = spies.updateHost.mock.calls.filter(c => 'domain_names' in (c[3] as Record<string, unknown>));
    expect(writeCalls).toHaveLength(0);
    // Cert skipped (has certificate_id).
    expect(spies.requestCert).not.toHaveBeenCalled();
    expect(spies.bindCert).not.toHaveBeenCalled();
  });
});
