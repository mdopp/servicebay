/**
 * Delete → restore round trip through the REAL capability bus (#2541).
 *
 * The two halves are worthless proven separately: what breaks is the trip.
 * So this test registers the five real handlers (`initCapabilities`), mocks
 * only their outbound edges (NPM/Authelia HTTP, AdGuard, nftables, the
 * agent, config persistence) and then drives the actual lifecycle methods:
 *
 *   ServiceLifecycle.deleteService('Local', 'immich')
 *     → OIDC client DELETEd, proxy host DELETEd, AdGuard rewrite removed,
 *       credentials-manifest entry stripped, firewall port dropped
 *   ServiceLifecycle.restoreTrashedService('Local', '<trash-id>')
 *     → all five come back
 *
 * Before this change, restore re-provisioned nothing — a restored service
 * came back with no SSO and no proxy route — which is why the cleanup half
 * could not ship on its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '@/lib/config';

// ---------------------------------------------------------------- fixtures

const TEMPLATE = 'immich';
const TRASH_ID = '2026-08-13T10-00-00-000Z-immich';

const DECLARATIONS: Record<string, Record<string, unknown>> = {
  [TEMPLATE]: {
    IMMICH_SUBDOMAIN: {
      type: 'subdomain',
      default: 'photos',
      exposure: 'internal',
      proxyPort: 'IMMICH_PORT',
      oidcClient: {
        client_id: 'immich',
        client_name: 'Immich',
        clientSecretVar: 'IMMICH_OIDC_SECRET',
      },
    },
    // Operator changed this away from the default in Configure — the
    // reconstruction must read `installedVariables` (#2531), not the default,
    // or both the proxy host and the firewall rule target the wrong port.
    IMMICH_PORT: { type: 'text', default: '2283', blockLanAccess: true },
    IMMICH_OIDC_SECRET: { type: 'secret' },
  },
};

const TEMPLATE_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: immich
  annotations:
    servicebay.label: "Immich"
    servicebay.tier: "feature"
spec:
  containers:
    - name: immich
      image: example.com/immich:latest
`;

function freshConfig(): AppConfig {
  return {
    reverseProxy: { publicDomain: 'example.com' },
    templateSettings: { DATA_DIR: '/mnt/data/stacks' },
    installedTemplates: { [TEMPLATE]: { schemaVersion: 1, installedAt: '2026-08-01T00:00:00Z' } },
    installedSecrets: [{ varName: 'IMMICH_OIDC_SECRET', password: 'oidc-secret-value' }],
    installedVariables: [{ varName: 'IMMICH_PORT', value: '9999' }],
    installManifest: {
      savedAt: '2026-08-01T00:00:00Z',
      credentials: [
        {
          service: 'Immich OIDC client_secret',
          url: 'https://auth.example.com',
          username: 'immich',
          password: 'oidc-secret-value',
          importance: 'system',
          template: TEMPLATE,
        },
        // Foreign entry — must survive both halves untouched.
        {
          service: 'LLDAP admin',
          url: 'https://lldap.example.com',
          username: 'admin',
          password: 'other',
          importance: 'critical',
          template: 'lldap',
        },
      ],
    },
  } as unknown as AppConfig;
}

let config: AppConfig;

// ----------------------------------------------------------------- mocks

vi.mock('@/lib/config', () => ({
  getConfig: async () => config,
  saveConfig: async (next: AppConfig) => { config = next; },
  updateConfig: async (patch: Partial<AppConfig>) => { config = { ...config, ...patch }; },
}));

const sendCommand = vi.fn(async (verb: string, payload?: { command?: string; path?: string }) => {
  if (verb === 'exec' && payload?.command?.includes('.manifest.json') && payload.command.startsWith('cat')) {
    return {
      code: 0,
      stdout: JSON.stringify({
        service: TEMPLATE,
        deletedAt: '2026-08-13T10:00:00.000Z',
        originalYamlPath: `.config/containers/systemd/${TEMPLATE}.yml`,
        originalKubePath: `~/.config/containers/systemd/${TEMPLATE}.kube`,
      }),
      stderr: '',
    };
  }
  return { code: 0, stdout: '', stderr: '' };
});
vi.mock('@/lib/agent/manager', () => ({
  agentManager: { ensureAgent: async () => ({ sendCommand }) },
}));

vi.mock('@/lib/services/serviceListing', () => ({
  ServiceListing: {
    getServiceFiles: async () => ({
      kubeContent: '',
      yamlContent: '',
      yamlPath: `.config/containers/systemd/${TEMPLATE}.yml`,
    }),
    listTrashedServices: async () => [],
  },
}));

vi.mock('@/lib/health/store', () => ({
  HealthStore: { deleteServiceCheck: () => 0 },
}));

vi.mock('@/lib/registry', () => ({
  getTemplateVariables: async (name: string) => DECLARATIONS[name] ?? null,
  getTemplateYaml: async (name: string) => (name === TEMPLATE ? TEMPLATE_YAML : null),
}));

interface FetchCall { url: string; method: string; body: Record<string, unknown> | undefined }
const fetchCalls: FetchCall[] = [];
vi.mock('@/lib/api/internalFetch', () => ({
  internalFetch: async (url: string, init?: { method?: string; body?: string }) => {
    fetchCalls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ created: [], added: [], skipped: [] }),
    };
  },
}));

const ensureRewrite = vi.fn(async () => 'created' as const);
const removeRewrite = vi.fn(async () => 'removed' as const);
vi.mock('@/lib/adguard/rewrites', () => ({
  ensureWildcardRewrite: (...a: unknown[]) => ensureRewrite(...(a as [])),
  removeWildcardRewrite: (...a: unknown[]) => removeRewrite(...(a as [])),
}));

vi.mock('@/lib/portal/provisioner', () => ({
  findAdguardCreds: async () => ({ host: 'http://adguard', username: 'admin', password: 'pw' }),
  findServiceBayLanIp: async () => '192.168.1.10',
}));

vi.mock('@/lib/executor', () => ({ getExecutor: () => ({}) }));

const reconciledPorts: number[][] = [];
vi.mock('@/lib/hostFirewall', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hostFirewall')>();
  return {
    ...actual,
    // Keep `collectLanBlockedPorts` real — the port set is the assertion.
    reconcileHostFirewall: async (_exec: unknown, ports: number[]) => { reconciledPorts.push(ports); },
  };
});

import { getCapabilityBus } from '@/lib/capabilities/bus';
import { initCapabilities } from '@/lib/capabilities/init';
import { ServiceLifecycle } from '@/lib/services/serviceLifecycle';

// ---------------------------------------------------------------- helpers

const callsTo = (method: string, needle: string) =>
  fetchCalls.filter(c => c.method === method && c.url.includes(needle));

const credentialTemplates = () =>
  (config.installManifest?.credentials ?? []).map(c => (c as { template?: string }).template);

describe('#2541 — delete → restore round trip', () => {
  beforeEach(() => {
    config = freshConfig();
    fetchCalls.length = 0;
    reconciledPorts.length = 0;
    ensureRewrite.mockClear();
    removeRewrite.mockClear();
    sendCommand.mockClear();
    getCapabilityBus().reset();
    initCapabilities();
  });

  it('cleans up all five neighbours on delete, then rebuilds all five on restore', async () => {
    // ---- delete -------------------------------------------------------
    await ServiceLifecycle.deleteService('Local', TEMPLATE);

    // 1. Authelia OIDC client
    expect(callsTo('DELETE', '/api/system/authelia/oidc-clients/immich')).toHaveLength(1);
    // 2. NPM proxy host — proves the reconstruction carried `meta`, without
    //    which `buildProxyHosts` produces no hosts at all.
    expect(callsTo('DELETE', 'proxy-hosts?domain=photos.example.com')).toHaveLength(1);
    // 3. AdGuard rewrite
    expect(removeRewrite).toHaveBeenCalledWith(expect.anything(), 'photos.example.com');
    // 4. Credentials-manifest entry (foreign entry survives)
    expect(credentialTemplates()).toEqual(['lldap']);
    // 5. Firewall rule — the OPERATOR-set port, not the template default.
    expect(reconciledPorts.at(-1)).toEqual([]);

    // ---- restore ------------------------------------------------------
    fetchCalls.length = 0;
    const result = await ServiceLifecycle.restoreTrashedService('Local', TRASH_ID);
    expect(result.service).toBe(TEMPLATE);
    expect(result.capabilityFailures).toEqual([]);

    // 1. OIDC client re-registered for this template
    const oidcPost = callsTo('POST', '/api/system/authelia/oidc-clients');
    expect(oidcPost).toHaveLength(1);
    expect(oidcPost[0].body).toMatchObject({
      templates: [{ name: TEMPLATE }],
      variables: expect.objectContaining({ PUBLIC_DOMAIN: 'example.com', IMMICH_SUBDOMAIN: 'photos' }),
    });
    // 2. Proxy host re-created, forwarding to the operator-set port
    const hostPost = callsTo('POST', '/api/system/nginx/proxy-hosts');
    expect(hostPost).toHaveLength(1);
    expect(hostPost[0].body).toMatchObject({
      publicDomain: 'example.com',
      hosts: [expect.objectContaining({ domain: 'photos.example.com', forwardPort: 9999 })],
    });
    // 3. AdGuard rewrite back
    expect(ensureRewrite).toHaveBeenCalledWith(expect.anything(), 'photos.example.com', '192.168.1.10');
    // 4. Credentials-manifest entry back, with the persisted secret
    expect(credentialTemplates().sort()).toEqual(['immich', 'lldap']);
    expect(
      (config.installManifest?.credentials ?? []).find(c => (c as { template?: string }).template === TEMPLATE),
    ).toMatchObject({ username: 'immich', password: 'oidc-secret-value' });
    // 5. Firewall rule back on the operator-set port
    expect(reconciledPorts.at(-1)).toEqual([9999]);
  });

  it('fires feature.uninstalling before the unit is stopped', async () => {
    const seen: string[] = [];
    getCapabilityBus().subscribe('feature.uninstalling', 'probe', async (event) => {
      seen.push(`uninstalling:${event.template}:${sendCommand.mock.calls.length}`);
      return { ok: true };
    });

    await ServiceLifecycle.deleteService('Local', TEMPLATE);

    // Zero agent commands had run when the pre-stop hook fired — that is
    // the whole contract of `feature.uninstalling` (kept, not dropped).
    expect(seen).toEqual([`uninstalling:${TEMPLATE}:0`]);
  });

  it('skips the capability events when the caller owns them (stack wipe / migration)', async () => {
    await ServiceLifecycle.deleteService('Local', TEMPLATE, { emitCapabilityEvents: false });

    expect(fetchCalls).toHaveLength(0);
    expect(removeRewrite).not.toHaveBeenCalled();
    expect(credentialTemplates().sort()).toEqual(['immich', 'lldap']);
  });

  it('reports a handler that could not re-provision instead of restoring silently', async () => {
    getCapabilityBus().subscribe('feature.installed', 'exploding', async () => ({
      ok: false,
      retryable: false,
      message: 'authelia unreachable',
    }));

    const result = await ServiceLifecycle.restoreTrashedService('Local', TRASH_ID);

    expect(result.capabilityFailures).toEqual([
      { handler: 'exploding', message: 'authelia unreachable' },
    ]);
    // …and it lands in the standing-failure store diagnose reads.
    expect(config.installHandlerFailures?.[`capability:${TEMPLATE}`]).toMatchObject({
      service: TEMPLATE,
      message: 'exploding: authelia unreachable',
    });
  });
});
