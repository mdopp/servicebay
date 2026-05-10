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
import './certExpiry';

const ACTIVE_NGINX = [{ name: 'nginx', active: true, ports: [{ host: '8081', container: '81' }] }];

beforeEach(() => {
  state.config = { reverseProxy: { npm: { email: 'a@b.c', password: 'pw' } } };
  state.services = ACTIVE_NGINX;
  mockFetch.mockReset();
});

describe('cert_expiry.renew_cert', () => {
  it('rejects empty itemId', async () => {
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects non-numeric ids', async () => {
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      itemId: 'abc; rm -rf /',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/numeric/);
  });

  it('aborts when nginx is missing', async () => {
    state.services = [];
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      itemId: '5',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not deployed/);
  });

  it('triggers NPM renew on success', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tok' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('') });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      itemId: '7',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Renewal triggered for cert 7/);
    expect(mockFetch.mock.calls[1][0]).toMatch(/\/api\/nginx\/certificates\/7\/renew/);
    expect(mockFetch.mock.calls[1][1].method).toBe('POST');
  });

  it('surfaces NPM HTTP error on renewal failure', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'tok' }) })
      .mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('challenge failed') });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      itemId: '7',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/HTTP 500/);
  });

  it('reports auth failure when NPM rejects every credential candidate', async () => {
    // Both /api/tokens calls return 401 → token resolution fails
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => Promise.resolve({}) });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      itemId: '7',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/authenticate/);
  });
});
