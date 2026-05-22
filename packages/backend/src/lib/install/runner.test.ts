/**
 * Install-runner unit tests (#810).
 *
 * Covers the inter-template readiness gate: `isServiceReady` (the
 * readiness predicate) and `waitForDependencies` (the gate that blocks
 * a template's deploy until its declared dependencies are healthy).
 *
 * The twin is mocked the same way `stackRunner.test.ts` does it, so the
 * gate reads deterministic fixtures instead of a live digital twin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const twinStub: {
  nodes: Record<string, { services?: Array<{ name: string; active?: boolean; health?: { ready: boolean } }> }>;
} = { nodes: {} };
vi.mock('@/lib/store/twin', () => ({
  DigitalTwinStore: {
    getInstance: () => ({
      getSnapshot: () => ({ nodes: twinStub.nodes }),
    }),
  },
}));

// The gate registers deployed services with the health poller before
// polling. In a unit test there is no agent to list services from, so
// stub the bootstrap to a no-op.
const bootstrapMock = vi.fn().mockResolvedValue({ registered: [], skipped: [] });
vi.mock('@/lib/health/serviceHealthBootstrap', () => ({
  bootstrapServiceHealth: () => bootstrapMock(),
}));

// `ensureProxyHosts` POSTs via the loopback apiFetch, which attaches the
// internal token — stub it so the test doesn't need a real token file.
vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: () => 'test-token',
}));

import { isServiceReady, waitForDependencies, ensureProxyHosts } from './runner';
import type { StackVariable } from '@/lib/stackInstall/postInstall';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeEach(() => {
  twinStub.nodes = {};
  bootstrapMock.mockClear();
  fetchSpy.mockReset();
});

describe('isServiceReady', () => {
  it('prefers the health signal over systemd-active', () => {
    // active=true but health.ready=false → not ready (app still booting
    // inside an active unit — the exact #810 failure mode).
    expect(isServiceReady([{ name: 'auth', active: true, health: { ready: false } }], 'auth')).toBe(false);
    expect(isServiceReady([{ name: 'auth', active: false, health: { ready: true } }], 'auth')).toBe(true);
  });

  it('falls back to systemd-active when no health signal is present', () => {
    expect(isServiceReady([{ name: 'nginx', active: true }], 'nginx')).toBe(true);
    expect(isServiceReady([{ name: 'nginx', active: false }], 'nginx')).toBe(false);
  });

  it('matches a unit name with or without the .service suffix', () => {
    expect(isServiceReady([{ name: 'auth.service', active: true }], 'auth')).toBe(true);
  });

  it('returns false when the service is absent from the twin', () => {
    expect(isServiceReady([{ name: 'nginx', active: true }], 'auth')).toBe(false);
  });
});

describe('waitForDependencies', () => {
  it('returns immediately when the item declares no dependencies', async () => {
    await waitForDependencies('job1', { name: 'ollama', dependencies: [] }, 'Local');
    // No twin read, no health bootstrap when there is nothing to gate on.
    expect(bootstrapMock).not.toHaveBeenCalled();
  });

  it('resolves once every declared dependency is healthy', async () => {
    twinStub.nodes['Local'] = {
      services: [
        { name: 'nginx', health: { ready: true } },
        { name: 'auth', health: { ready: true } },
      ],
    };
    await expect(
      waitForDependencies('job1', { name: 'media', dependencies: ['nginx', 'auth'] }, 'Local'),
    ).resolves.toBeUndefined();
    // The gate registers deployed services with the health poller first.
    expect(bootstrapMock).toHaveBeenCalledTimes(1);
  });
});

describe('ensureProxyHosts', () => {
  const subdomainVar = (template: string, varName: string, sub: string): StackVariable => ({
    name: varName,
    value: sub,
    meta: {
      type: 'subdomain',
      templateName: template,
      proxyPort: '2283',
      exposure: 'public',
    } as StackVariable['meta'],
  });

  it('POSTs every subdomain host in one batch, even across templates', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ success: true, created: ['photos.dopp.cloud', 'vault.dopp.cloud'] }), { status: 200 }),
    );
    const variables: StackVariable[] = [
      { name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' },
      subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos'),
      subdomainVar('vaultwarden', 'VAULTWARDEN_SUBDOMAIN', 'vault'),
    ];
    await ensureProxyHosts('job1', variables, undefined);
    // Single consolidated POST — not one-per-template.
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/system\/nginx\/proxy-hosts$/);
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.publicDomain).toBe('dopp.cloud');
    const domains = body.hosts.map((h: { domain: string }) => h.domain).sort();
    expect(domains).toEqual(['photos.dopp.cloud', 'vault.dopp.cloud']);
  });

  it('no-ops on a pure-LAN install with no PUBLIC_DOMAIN', async () => {
    await ensureProxyHosts('job1', [subdomainVar('immich', 'IMMICH_SUBDOMAIN', 'photos')], undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('no-ops when there are no subdomain-typed variables', async () => {
    await ensureProxyHosts('job1', [{ name: 'PUBLIC_DOMAIN', value: 'dopp.cloud' }], undefined);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
