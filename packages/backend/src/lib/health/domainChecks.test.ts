import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetConfig, mockGetProxyState, mockGetChecks, saved, deleted } = vi.hoisted(() => ({
  mockGetConfig: vi.fn(),
  mockGetProxyState: vi.fn(),
  mockGetChecks: vi.fn(),
  saved: [] as Array<Record<string, unknown>>,
  deleted: [] as string[],
}));

vi.mock('../config', () => ({ getConfig: () => mockGetConfig() }));
vi.mock('../store/repository', () => ({ getProxyState: () => mockGetProxyState() }));
vi.mock('./store', () => ({
  HealthStore: {
    getChecks: () => mockGetChecks(),
    saveCheck: (c: Record<string, unknown>) => { saved.push(c); },
    deleteCheck: (id: string) => { deleted.push(id); },
  },
}));
vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { syncDomainChecks } from './domainChecks';

const route = (host: string, targetPort: number, ssl: boolean) =>
  ({ host, targetService: 'x', targetPort, ssl });

beforeEach(() => {
  saved.length = 0; deleted.length = 0;
  mockGetConfig.mockResolvedValue({ reverseProxy: { hosts: [] } });
  mockGetChecks.mockReturnValue([]);
  mockGetProxyState.mockReturnValue({ provider: 'nginx', routes: [] });
});

describe('syncDomainChecks (#1416)', () => {
  it('registers a check for every FQDN route and skips NPM-internal hosts', async () => {
    mockGetProxyState.mockReturnValue({ routes: [
      route('admin.dopp.cloud', 5888, true),
      route('ldap.dopp.cloud', 17170, true),
      route('nginxproxymanager', 3000, false),
      route('localhost-nginx-proxy-manager', 80, true),
    ]});

    await syncDomainChecks();

    const ids = saved.map(c => c.id);
    expect(ids).toContain('domain:admin.dopp.cloud');
    expect(ids).toContain('domain:ldap.dopp.cloud');
    // NPM-internal hosts (no FQDN / localhost) are never registered.
    expect(saved.some(c => c.target === 'nginxproxymanager' || c.target === 'localhost-nginx-proxy-manager')).toBe(false);

    const admin = saved.find(c => c.id === 'domain:admin.dopp.cloud') as { domainConfig: Record<string, unknown> };
    expect(admin.domainConfig.expectedScheme).toBe('https'); // from route.ssl
    expect(admin.domainConfig.upstreamPort).toBe(5888);
  });

  it('prefers config exposure over the route TLS flag for known hosts', async () => {
    mockGetConfig.mockResolvedValue({ reverseProxy: { hosts: [
      { domain: 'ldap.dopp.cloud', forwardPort: 17170, exposure: 'lan' },
    ]}});
    mockGetProxyState.mockReturnValue({ routes: [route('ldap.dopp.cloud', 17170, true)] });

    await syncDomainChecks();

    const ldap = saved.find(c => c.id === 'domain:ldap.dopp.cloud') as { domainConfig: Record<string, unknown> };
    expect(ldap.domainConfig.isPublic).toBe(false);      // exposure 'lan'
    expect(ldap.domainConfig.expectedScheme).toBe('http'); // config wins over route.ssl
  });

  it('does NOT remove existing checks when the route snapshot is empty (transient)', async () => {
    mockGetChecks.mockReturnValue([
      { id: 'domain:admin.dopp.cloud', type: 'domain', target: 'admin.dopp.cloud', interval: 60, enabled: true, domainConfig: { expectedScheme: 'https', isPublic: true, upstreamPort: 5888 } },
    ]);
    mockGetProxyState.mockReturnValue({ routes: [] });

    await syncDomainChecks();

    expect(deleted).toEqual([]);
  });

  it('removes a domain check whose host vanished from NPM (non-empty snapshot)', async () => {
    mockGetChecks.mockReturnValue([
      { id: 'domain:gone.dopp.cloud', type: 'domain', target: 'gone.dopp.cloud', interval: 60, enabled: true, domainConfig: { expectedScheme: 'https', isPublic: true, upstreamPort: 1 } },
    ]);
    mockGetProxyState.mockReturnValue({ routes: [route('admin.dopp.cloud', 5888, true)] });

    await syncDomainChecks();

    expect(deleted).toContain('domain:gone.dopp.cloud');
  });

  // #2654 — the route table is an agent-poll snapshot, so a reconcile fired
  // straight from a live-host deletion still sees the host. Without
  // `removedDomains` the sync REBUILDS the check it was called to retire, and
  // the domain row survives for up to 60s — the window in which
  // `get_health_checks` listed a `domain:` id `delete_health_check` rejected.
  describe('removedDomains — the caller outranks the stale route snapshot (#2654)', () => {
    it('retires the check even while the polled route table still lists the host', async () => {
      mockGetChecks.mockReturnValue([
        { id: 'domain:gone.dopp.cloud', type: 'domain', target: 'gone.dopp.cloud', interval: 60, enabled: true, created_at: 't', nodeName: 'Local', domainConfig: { expectedScheme: 'https', isPublic: true, upstreamPort: 1 } },
      ]);
      mockGetProxyState.mockReturnValue({ routes: [
        route('gone.dopp.cloud', 1, true),
        route('admin.dopp.cloud', 5888, true),
      ]});

      await syncDomainChecks({ removedDomains: ['gone.dopp.cloud'] });

      expect(deleted).toContain('domain:gone.dopp.cloud');
      // …and it is NOT re-saved from the stale route in the same pass.
      expect(saved.map(c => c.id)).not.toContain('domain:gone.dopp.cloud');
    });

    it('retires it even when the route snapshot is empty (orphan pass is skipped there)', async () => {
      mockGetChecks.mockReturnValue([
        { id: 'domain:gone.dopp.cloud', type: 'domain', target: 'gone.dopp.cloud', interval: 60, enabled: true, domainConfig: {} },
      ]);
      mockGetProxyState.mockReturnValue({ routes: [] });

      await syncDomainChecks({ removedDomains: ['gone.dopp.cloud'] });

      expect(deleted).toEqual(['domain:gone.dopp.cloud']);
    });

    it('leaves a stale config entry for the removed domain from resurrecting it', async () => {
      mockGetConfig.mockResolvedValue({ reverseProxy: { hosts: [
        { domain: 'gone.dopp.cloud', forwardPort: 1, exposure: 'public' },
      ]}});
      mockGetChecks.mockReturnValue([]);
      mockGetProxyState.mockReturnValue({ routes: [route('admin.dopp.cloud', 5888, true)] });

      await syncDomainChecks({ removedDomains: ['gone.dopp.cloud'] });

      expect(saved.map(c => c.id)).not.toContain('domain:gone.dopp.cloud');
    });

    it('touches nothing extra when no domain was removed (default call is unchanged)', async () => {
      mockGetChecks.mockReturnValue([
        { id: 'domain:admin.dopp.cloud', type: 'domain', target: 'admin.dopp.cloud', interval: 60, enabled: true, created_at: 't', nodeName: 'Local', domainConfig: { expectedScheme: 'https', isPublic: true, upstreamPort: 5888 } },
      ]);
      mockGetProxyState.mockReturnValue({ routes: [route('admin.dopp.cloud', 5888, true)] });

      await syncDomainChecks();

      expect(deleted).toEqual([]);
      expect(saved).toEqual([]);
    });
  });

  it('does not churn an unchanged existing check', async () => {
    mockGetChecks.mockReturnValue([
      { id: 'domain:admin.dopp.cloud', type: 'domain', target: 'admin.dopp.cloud', interval: 60, enabled: true, created_at: 't', nodeName: 'Local', domainConfig: { expectedScheme: 'https', isPublic: true, upstreamPort: 5888 } },
    ]);
    mockGetProxyState.mockReturnValue({ routes: [route('admin.dopp.cloud', 5888, true)] });

    await syncDomainChecks();

    expect(saved).toEqual([]);
  });
});
