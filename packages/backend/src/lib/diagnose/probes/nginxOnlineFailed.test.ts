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

import { checkNginxOnlineFailed } from './nginxOnlineFailed';
import { dispatchProbeAction } from '../actions';
import './nginxOnlineFailed';

const ACTIVE_NGINX = [{ name: 'nginx', active: true, ports: [{ host: '8081', container: '81' }] }];

const tokenOk = () => ({ ok: true, json: () => Promise.resolve({ token: 'tok' }) });
const hostList = (hosts: any[]) => ({ ok: true, json: () => Promise.resolve(hosts) });

beforeEach(() => {
  state.config = { reverseProxy: { npm: { email: 'a@b.c', password: 'pw' } } };
  state.services = ACTIVE_NGINX;
  mockFetch.mockReset();
});

describe('nginx_online_failed check', () => {
  it('is info when nginx is not deployed', async () => {
    state.services = [];
    const r = await checkNginxOnlineFailed('Local');
    expect(r.status).toBe('info');
  });

  it('is ok when every host has nginx_online=true', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(hostList([
        { id: 1, domain_names: ['a.example.com'], meta: { nginx_online: true } },
        { id: 2, domain_names: ['b.example.com'], meta: { nginx_online: true } },
      ]));
    const r = await checkNginxOnlineFailed('Local');
    expect(r.status).toBe('ok');
    expect(r.items).toBeUndefined();
  });

  it('fails and surfaces nginx_err for a host with nginx_online=false', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(hostList([
        { id: 1, domain_names: ['ok.example.com'], meta: { nginx_online: true } },
        {
          id: 9,
          domain_names: ['tor.dopp.cloud'],
          meta: { nginx_online: false, nginx_err: 'nginx: [emerg] duplicate location "/.well-known/acme-challenge/"' },
        },
      ]));
    const r = await checkNginxOnlineFailed('Local');
    expect(r.status).toBe('fail');
    expect(r.items).toHaveLength(1);
    expect(r.items?.[0].id).toBe('tor.dopp.cloud');
    expect(r.items?.[0].detail).toMatch(/duplicate location/);
    expect(r.items?.[0].actionIds).toContain('rerender_host');
    expect(r.detail).toMatch(/nginx_online=false/);
  });

  it('degrades to info (not false-ok) when the host list can not be read', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce({ ok: false, status: 502, json: () => Promise.resolve({}) });
    const r = await checkNginxOnlineFailed('Local');
    expect(r.status).toBe('info');
  });
});

describe('nginx_online_failed.rerender_host action', () => {
  it('rejects empty itemId', async () => {
    const r = await dispatchProbeAction({ probeId: 'nginx_online_failed', actionId: 'rerender_host', node: 'Local' });
    expect(r.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('disable→enables the matching id and reports online after a good re-render', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenOk()) // /api/tokens
      .mockResolvedValueOnce(hostList([{ id: 9, domain_names: ['tor.dopp.cloud'], meta: { nginx_online: false } }])) // resolve id
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // disable
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // enable
      .mockResolvedValueOnce(hostList([{ id: 9, domain_names: ['tor.dopp.cloud'], meta: { nginx_online: true } }])); // read-back
    const r = await dispatchProbeAction({
      probeId: 'nginx_online_failed',
      actionId: 'rerender_host',
      itemId: 'tor.dopp.cloud',
      node: 'Local',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/nginx_online=true/);
    // disable hit /9/disable, enable hit /9/enable
    expect(mockFetch.mock.calls[2][0]).toMatch(/\/proxy-hosts\/9\/disable$/);
    expect(mockFetch.mock.calls[3][0]).toMatch(/\/proxy-hosts\/9\/enable$/);
  });

  it('reports still-offline when the conf is still broken after re-render', async () => {
    mockFetch
      .mockResolvedValueOnce(tokenOk())
      .mockResolvedValueOnce(hostList([{ id: 9, domain_names: ['tor.dopp.cloud'], meta: { nginx_online: false } }]))
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // disable
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('') }) // enable
      .mockResolvedValueOnce(hostList([
        { id: 9, domain_names: ['tor.dopp.cloud'], meta: { nginx_online: false, nginx_err: 'still bad' } },
      ]));
    const r = await dispatchProbeAction({
      probeId: 'nginx_online_failed',
      actionId: 'rerender_host',
      itemId: 'tor.dopp.cloud',
      node: 'Local',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/still offline/i);
    expect(r.details).toMatch(/still bad/);
  });
});
