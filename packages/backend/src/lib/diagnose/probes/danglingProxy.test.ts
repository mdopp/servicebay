/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  config: {} as any,
  services: [] as any[],
  twin: null as any,
};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: vi.fn(() => Promise.resolve(state.services)) },
}));

vi.mock('@/lib/store/repository', () => ({
  getNodeTwin: vi.fn(() => state.twin),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { dispatchProbeAction } from '../actions';
import './danglingProxy';

const ACTIVE_NGINX = [{ name: 'nginx', active: true, ports: [{ host: '8081', container: '81' }] }];

beforeEach(() => {
  state.config = { reverseProxy: { npm: { email: 'a@b.c', password: 'pw' } } };
  state.services = ACTIVE_NGINX;
  // Default: the twin has no service list, so the #2611 re-derive can't
  // establish a verdict and the pre-existing behaviour is unchanged.
  state.twin = null;
  mockFetch.mockReset();
});

/** #2611 — the live shape the issue was filed from: the route is on the
 *  old port, the owning service is up on the new one. */
function seedPortMoved() {
  state.config = {
    reverseProxy: {
      npm: { email: 'a@b.c', password: 'pw' },
      hosts: [{ domain: 'daggerheart.dopp.cloud', service: 'daggerheart-chronik', forwardPort: 8700, created: true }],
    },
  };
  state.twin = {
    services: [{
      name: 'daggerheart-chronik',
      ports: [{ hostPort: 8701, containerPort: 8701, protocol: 'tcp', hostIp: '192.168.178.100' }],
    }],
  };
}

/** NPM handshake: POST /api/tokens, then GET the host list. */
function mockNpmHandshake(hosts: unknown[]) {
  mockFetch
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tok' }) })
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(hosts) });
}

const DAGGERHEART_HOST = {
  id: 7,
  domain_names: ['daggerheart.dopp.cloud'],
  forward_host: '192.168.178.100',
  forward_port: 8700,
};

describe('dangling_proxy.delete_route', () => {
  it('rejects empty itemId', async () => {
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'delete_route',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('aborts when nginx is not deployed', async () => {
    state.services = [];
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'delete_route',
      itemId: 'old.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not deployed/i);
  });

  it('returns failure when NPM auth fails', async () => {
    // /api/tokens with stored creds → 401
    // /api/tokens with default creds → 401
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) });
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'delete_route',
      itemId: 'old.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not authenticate/);
  });

  it('reports when domain not found in NPM host list', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tok' }) }) // /api/tokens
      .mockResolvedValueOnce({ // /api/nginx/proxy-hosts list
        ok: true,
        json: () => Promise.resolve([
          { id: 5, domain_names: ['vault.example.com'] },
        ]),
      });
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'delete_route',
      itemId: 'gone.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Couldn't find/);
  });

  it('DELETEs the matching id and returns success', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tok' }) }) // /api/tokens
      .mockResolvedValueOnce({ // host list
        ok: true,
        json: () => Promise.resolve([
          { id: 7, domain_names: ['old.example.com'] },
          { id: 8, domain_names: ['vault.example.com'] },
        ]),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('') }); // DELETE
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'delete_route',
      itemId: 'old.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Route old\.example\.com removed/);
    // Verify DELETE went to id=7, not id=8
    const deleteCall = mockFetch.mock.calls[2];
    expect(deleteCall[0]).toMatch(/\/api\/nginx\/proxy-hosts\/7$/);
    expect(deleteCall[1].method).toBe('DELETE');
  });

  // #2611 — the row can be an hour old, so the destructive action
  // re-derives the state before it acts (the #2594 pattern).
  it('refuses to delete a route whose service turned out to be alive on another port', async () => {
    seedPortMoved();
    mockNpmHandshake([DAGGERHEART_HOST]);
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'delete_route',
      itemId: 'daggerheart.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Not deleted/);
    expect(result.message).toMatch(/publishes 8701/);
    expect(result.message).toMatch(/Repoint route/);
    // Nothing was sent beyond the token + list reads.
    expect(mockFetch.mock.calls).toHaveLength(2);
  });

  it('refuses to delete a route whose service is merely silent', async () => {
    seedPortMoved();
    state.twin = { services: [{ name: 'daggerheart-chronik', ports: [] }] };
    mockNpmHandshake([DAGGERHEART_HOST]);
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'delete_route',
      itemId: 'daggerheart.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/still exists/);
    expect(mockFetch.mock.calls).toHaveLength(2);
  });

  it('still deletes when the owning service is genuinely gone', async () => {
    seedPortMoved();
    state.twin = { services: [{ name: 'something-else', ports: [{ hostPort: 1, protocol: 'tcp' }] }] };
    mockNpmHandshake([DAGGERHEART_HOST]);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('') });
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'delete_route',
      itemId: 'daggerheart.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(mockFetch.mock.calls[2][1].method).toBe('DELETE');
  });
});

describe('dangling_proxy.repoint_route', () => {
  it('is registered, so a port-moved row renders a button', async () => {
    const { actionsForProbe } = await import('../actions');
    const action = actionsForProbe('dangling_proxy').find(a => a.id === 'repoint_route');
    expect(action?.label).toBe('Repoint route');
    // Recovery, not data loss — no confirm gate, unlike delete_route.
    expect(action?.destructive).toBeFalsy();
  });

  it('PUTs only the forward port, leaving cert and exposure alone', async () => {
    seedPortMoved();
    mockNpmHandshake([DAGGERHEART_HOST, { id: 8, domain_names: ['vault.dopp.cloud'] }]);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('') });
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'repoint_route',
      itemId: 'daggerheart.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/8701/);
    expect(result.message).toMatch(/8700/);
    const put = mockFetch.mock.calls[2];
    expect(put[0]).toMatch(/\/api\/nginx\/proxy-hosts\/7$/);
    expect(put[1].method).toBe('PUT');
    // The narrow patch: no certificate_id, no access_list_id, no
    // advanced_config, and no forward_host (the bind did not change).
    expect(JSON.parse(put[1].body)).toEqual({ forward_port: 8701 });
  });

  it('also moves the forward host when the service went loopback-only', async () => {
    seedPortMoved();
    state.twin = {
      services: [{
        name: 'daggerheart-chronik',
        ports: [{ hostPort: 8701, containerPort: 8701, protocol: 'tcp', hostIp: '127.0.0.1' }],
      }],
    };
    mockNpmHandshake([DAGGERHEART_HOST]);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('') });
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'repoint_route',
      itemId: 'daggerheart.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(mockFetch.mock.calls[2][1].body))
      .toEqual({ forward_port: 8701, forward_host: '127.0.0.1' });
  });

  it('refuses rather than guessing when the service publishes several ports', async () => {
    seedPortMoved();
    state.twin = {
      services: [{
        name: 'daggerheart-chronik',
        ports: [
          { hostPort: 8701, containerPort: 8701, protocol: 'tcp' },
          { hostPort: 9001, containerPort: 9001, protocol: 'tcp' },
        ],
      }],
    };
    mockNpmHandshake([DAGGERHEART_HOST]);
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'repoint_route',
      itemId: 'daggerheart.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/8701, 9001/);
    expect(mockFetch.mock.calls).toHaveLength(2);
  });

  it('sends the operator to Delete route when the service really is gone', async () => {
    seedPortMoved();
    state.twin = { services: [{ name: 'unrelated', ports: [{ hostPort: 1, protocol: 'tcp' }] }] };
    mockNpmHandshake([DAGGERHEART_HOST]);
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'repoint_route',
      itemId: 'daggerheart.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Delete route/);
    expect(mockFetch.mock.calls).toHaveLength(2);
  });

  it('does nothing when the twin has no service list — no guess from missing data', async () => {
    seedPortMoved();
    state.twin = null;
    mockNpmHandshake([DAGGERHEART_HOST]);
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'repoint_route',
      itemId: 'daggerheart.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not available/);
    expect(mockFetch.mock.calls).toHaveLength(2);
  });

  it('reports an NPM rejection instead of claiming the route moved', async () => {
    seedPortMoved();
    mockNpmHandshake([DAGGERHEART_HOST]);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('boom') });
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'repoint_route',
      itemId: 'daggerheart.dopp.cloud',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/HTTP 500/);
  });

  it('rejects an empty itemId without touching NPM', async () => {
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'repoint_route',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('every action a route verdict can offer has a handler', () => {
  // resolveItemActions drops an unregistered id, which renders a row
  // with no button and no explanation. Pin the two directions together.
  it('registers a handler for each id actionIdsForVerdict can emit', async () => {
    const { actionIdsForVerdict } = await import('./danglingRouteState');
    const { actionsForProbe } = await import('../actions');
    const registered = new Set(actionsForProbe('dangling_proxy').map(a => a.id));
    const emitted = new Set([
      ...actionIdsForVerdict({ kind: 'port-moved', service: 'a', to: 1 }),
      ...actionIdsForVerdict({ kind: 'port-ambiguous', service: 'a', candidates: [1, 2] }),
      ...actionIdsForVerdict({ kind: 'service-silent', service: 'a' }),
      ...actionIdsForVerdict({ kind: 'target-gone' }),
    ]);
    expect(emitted.size).toBeGreaterThan(0);
    for (const id of emitted) expect(registered).toContain(id);
  });
});
