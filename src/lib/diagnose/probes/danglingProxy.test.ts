/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  config: {} as any,
  services: [] as any[],
};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: vi.fn(() => Promise.resolve(state.services)) },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { dispatchProbeAction } from '../actions';
import './danglingProxy';

const ACTIVE_NGINX = [{ name: 'nginx', active: true, ports: [{ host: '8081', container: '81' }] }];

beforeEach(() => {
  state.config = { reverseProxy: { npm: { email: 'a@b.c', password: 'pw' } } };
  state.services = ACTIVE_NGINX;
  mockFetch.mockReset();
});

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
});
