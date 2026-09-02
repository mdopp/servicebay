/**
 * `resolveNpmAdmin` / `getNpmToken` (#2730) — the one NPM admin resolver
 * that replaced ten diverging copies. The cases below are exactly the
 * divergences the merge had to make explicit: an inactive unit with and
 * without `requireActive`, the cold-start twin race, and a token minted
 * from none of the credential candidates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const twinNodes: Record<string, { services: unknown[]; containers: unknown[]; nodeIPs?: string[] }> = {};
const serviceLists: Record<string, unknown[]> = {};
let configState: Record<string, unknown> = {};

vi.mock('../store/twin', () => ({
  DigitalTwinStore: {
    getInstance: () => ({ nodes: twinNodes }),
  },
}));

vi.mock('../services/ServiceManager', () => ({
  ServiceManager: {
    listServices: vi.fn(async (node: string) => serviceLists[node] ?? []),
  },
}));

vi.mock('../config', () => ({
  getConfig: vi.fn(async () => configState),
}));

import { resolveNpmAdmin, findNpmAdmin, getNpmToken, loginNpm } from './client';

const populated = (extra: Partial<(typeof twinNodes)[string]> = {}) => ({
  services: [{ name: 'nginx-pod.service' }],
  containers: [{ id: 'abc' }],
  ...extra,
});

beforeEach(() => {
  for (const k of Object.keys(twinNodes)) delete twinNodes[k];
  for (const k of Object.keys(serviceLists)) delete serviceLists[k];
  configState = {};
  vi.unstubAllGlobals();
});

describe('resolveNpmAdmin', () => {
  it('reports twin-not-ready when no node has a populated twin yet', async () => {
    const r = await resolveNpmAdmin({ node: 'Local', requireActive: false });
    expect(r.kind).toBe('twin-not-ready');
  });

  it('reports twin-not-ready for a twin entry with empty services and containers', async () => {
    twinNodes['Local'] = { services: [], containers: [] };
    const r = await resolveNpmAdmin({ node: 'Local', requireActive: false });
    expect(r.kind).toBe('twin-not-ready');
  });

  it('reports nginx-not-found when the twin has data but nginx is not installed', async () => {
    twinNodes['Local'] = populated();
    serviceLists['Local'] = [{ name: 'adguard', active: true, ports: [] }];
    const r = await resolveNpmAdmin({ node: 'Local', requireActive: false });
    expect(r.kind).toBe('nginx-not-found');
  });

  it('reports nginx-inactive when the unit is inactive and the caller requires it active', async () => {
    twinNodes['Local'] = populated();
    serviceLists['Local'] = [{ name: 'nginx-web', active: false, ports: [{ host: '8181', container: '81' }] }];
    const r = await resolveNpmAdmin({ node: 'Local', requireActive: true });
    expect(r).toEqual({ kind: 'nginx-inactive', nodeName: 'Local' });
    expect(await findNpmAdmin({ node: 'Local', requireActive: true })).toBeNull();
  });

  it('resolves an inactive unit when the caller does not require it active (#496 unit-name mismatch)', async () => {
    twinNodes['Local'] = populated();
    serviceLists['Local'] = [
      { name: 'nginx-web', active: false, ports: [{ host: '80', container: '80' }, { host: '443', container: '443' }, { host: '8181', container: '8181' }] },
    ];
    const r = await resolveNpmAdmin({ node: 'Local', requireActive: false });
    expect(r).toEqual({ kind: 'ok', apiUrl: 'http://127.0.0.1:8181', nodeName: 'Local', nodeIp: '127.0.0.1' });
  });

  it('prefers the host port mapped to container 81 over the not-80/443 heuristic', async () => {
    twinNodes['Local'] = populated();
    serviceLists['Local'] = [
      { name: 'nginx', active: true, ports: [{ host: '9000', container: '9000' }, { host: '8181', container: '81' }] },
    ];
    const r = await findNpmAdmin({ node: 'Local', requireActive: true });
    expect(r?.apiUrl).toBe('http://127.0.0.1:8181');
  });

  it('falls back to the configured NGINX_ADMIN_PORT under hostNetwork (no host ports recorded)', async () => {
    twinNodes['Local'] = populated();
    configState = { templateSettings: { NGINX_ADMIN_PORT: '8081' } };
    serviceLists['Local'] = [
      { name: 'nginx', active: true, ports: [{ host: 'undefined', container: '80' }, { host: 'undefined', container: '81' }] },
    ];
    const r = await findNpmAdmin({ node: 'Local', requireActive: true });
    expect(r?.apiUrl).toBe('http://127.0.0.1:8081');
  });

  it('falls back to 81 when the manifest exposes only 80/443 and nothing is configured', async () => {
    twinNodes['Local'] = populated();
    serviceLists['Local'] = [{ name: 'nginx', active: true, ports: [{ host: '80', container: '80' }, { host: '443', container: '443' }] }];
    const r = await findNpmAdmin({ node: 'Local', requireActive: true });
    expect(r?.apiUrl).toBe('http://127.0.0.1:81');
  });

  it('ignores the install-* helper unit and matches the real nginx', async () => {
    twinNodes['Local'] = populated();
    serviceLists['Local'] = [
      { name: 'install-nginx', active: true, ports: [] },
      { name: 'nginx-web', active: true, ports: [{ host: '8181', container: '81' }] },
    ];
    const r = await findNpmAdmin({ node: 'Local', requireActive: true });
    expect(r?.apiUrl).toBe('http://127.0.0.1:8181');
  });

  it('iterates every twin node without a hint and addresses a remote node by its LAN IP', async () => {
    twinNodes['Local'] = populated();
    twinNodes['nas'] = populated({ nodeIPs: ['127.0.0.1', '192.168.1.20'] });
    serviceLists['Local'] = [{ name: 'adguard', active: true, ports: [] }];
    serviceLists['nas'] = [{ name: 'nginx', active: true, ports: [{ host: '81', container: '81' }] }];
    const r = await findNpmAdmin({ requireActive: true });
    expect(r).toEqual({ apiUrl: 'http://192.168.1.20:81', nodeName: 'nas', nodeIp: '192.168.1.20' });
  });

  it('skips a node whose listing throws instead of failing the whole resolution', async () => {
    twinNodes['Local'] = populated();
    twinNodes['nas'] = populated();
    serviceLists['nas'] = [{ name: 'nginx', active: true, ports: [{ host: '81', container: '81' }] }];
    const { ServiceManager } = await import('../services/ServiceManager');
    vi.mocked(ServiceManager.listServices).mockImplementation(async (node: string) => {
      if (node === 'Local') throw new Error('agent down');
      return serviceLists[node] as never;
    });
    const r = await findNpmAdmin({ requireActive: true });
    expect(r?.nodeName).toBe('nas');
  });
});

describe('getNpmToken', () => {
  const tokenServer = (accept: (body: { identity: string; secret: string }) => boolean) =>
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { identity: string; secret: string };
      return accept(body)
        ? new Response(JSON.stringify({ token: `tok-${body.identity}` }), { status: 200 })
        : new Response(JSON.stringify({ error: { message_i18n: 'error.invalid-auth' } }), { status: 401 });
    });

  it('returns null when no candidate authenticates (token missing)', async () => {
    configState = { reverseProxy: { npm: { email: 'ops@example.com', password: 'stale' } } };
    const fetchMock = tokenServer(() => false);
    vi.stubGlobal('fetch', fetchMock);
    expect(await getNpmToken('http://127.0.0.1:81')).toBeNull();
    // stored creds, then the wizard defaults — and nothing else
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:81/api/tokens');
  });

  it('tries provided credentials first, then stored, then defaults', async () => {
    configState = { reverseProxy: { npm: { email: 'ops@example.com', password: 'stored' } } };
    vi.stubGlobal('fetch', tokenServer(b => b.identity === 'ops@example.com' && b.secret === 'stored'));
    expect(await getNpmToken('http://127.0.0.1:81', { email: 'form@example.com', password: 'nope' })).toBe('tok-ops@example.com');

    vi.stubGlobal('fetch', tokenServer(b => b.identity === 'admin@example.com' && b.secret === 'changeme'));
    expect(await getNpmToken('http://127.0.0.1:81')).toBe('tok-admin@example.com');
  });

  it('survives a transport error and moves on to the next candidate', async () => {
    configState = { reverseProxy: { npm: { email: 'ops@example.com', password: 'stored' } } };
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ token: 'tok' }), { status: 200 });
    }));
    expect(await getNpmToken('http://127.0.0.1:81')).toBe('tok');
  });

  it('loginNpm never falls back: a rejected explicit credential is null', async () => {
    vi.stubGlobal('fetch', tokenServer(b => b.identity === 'admin@example.com'));
    expect(await loginNpm('http://127.0.0.1:81', { email: 'x@example.com', password: 'y' })).toBeNull();
    expect(await loginNpm('http://127.0.0.1:81', { email: 'admin@example.com', password: 'changeme' })).toBe('tok-admin@example.com');
  });
});
