/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` hoists above any top-level `const`, so we can't reference
// shared state directly. Instead, expose state via getters and mock
// modules with closures that read those getters at call time.
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

vi.mock('@/lib/auth/internalToken', () => ({
  getInternalApiToken: vi.fn(() => 'test-token'),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { dispatchProbeAction } from '../actions';
import './proxyRouteMissing';

beforeEach(() => {
  state.config = { reverseProxy: { hosts: [] } };
  state.services = [];
  mockFetch.mockReset();
});

const ACTIVE_NGINX = [{ name: 'nginx', active: true, ports: [{ host: '8081', container: '81' }] }];

describe('proxy_route_missing.retry_create', () => {
  it('rejects empty itemId', async () => {
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'retry_create',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns failure when entry not in config', async () => {
    state.config ={ reverseProxy: { hosts: [] } };
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'retry_create',
      itemId: 'vault.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/may have been removed/);
  });

  it('aborts when nginx is not deployed', async () => {
    state.config ={
      reverseProxy: {
        hosts: [{ domain: 'vault.example.com', service: 'vaultwarden', forwardPort: 8080, created: false }],
      },
    };
    state.services = [];
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'retry_create',
      itemId: 'vault.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not deployed/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('reports needs_credentials when NPM rejects auth', async () => {
    state.config ={
      reverseProxy: {
        hosts: [{ domain: 'vault.example.com', service: 'vaultwarden', forwardPort: 8080, created: false }],
      },
    };
    state.services = ACTIVE_NGINX;
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ needsCredentials: true }),
    });
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'retry_create',
      itemId: 'vault.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Use existing password/i);
  });

  it('returns ok on a successful create', async () => {
    state.config ={
      reverseProxy: {
        hosts: [{ domain: 'vault.example.com', service: 'vaultwarden', forwardPort: 8080, created: false }],
      },
    };
    state.services = ACTIVE_NGINX;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, created: ['vault.example.com'], failed: [] }),
    });
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'retry_create',
      itemId: 'vault.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Route vault\.example\.com created/);
  });

  it('surfaces the per-domain failure message when NPM rejects the host', async () => {
    state.config ={
      reverseProxy: {
        hosts: [{ domain: 'vault.example.com', service: 'vaultwarden', forwardPort: 8080, created: false }],
      },
    };
    state.services = ACTIVE_NGINX;
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({
        success: false,
        failed: [{ domain: 'vault.example.com', error: 'Domain already exists' }],
      }),
    });
    const result = await dispatchProbeAction({
      probeId: 'dangling_proxy',
      actionId: 'retry_create',
      itemId: 'vault.example.com',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Domain already exists/);
  });
});
