/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckResult } from '@/lib/health/types';

const state = {
  config: {} as any,
  services: [] as any[],
  results: new Map<string, CheckResult>(),
};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));

vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: vi.fn(() => Promise.resolve(state.services)) },
}));

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getLastResult: (id: string) => state.results.get(id) ?? null,
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { dispatchProbeAction } from '../actions';
import { checkCertExpiry } from './certExpiry';
import './certExpiry';

const ACTIVE_NGINX = [{ name: 'nginx', active: true, ports: [{ host: '8081', container: '81' }] }];

beforeEach(() => {
  state.config = { reverseProxy: { npm: { email: 'a@b.c', password: 'pw' } } };
  state.services = ACTIVE_NGINX;
  state.results = new Map();
  mockFetch.mockReset();
});

// ─── Reader (Phase 3b: thin HealthStore reader) ─────────────────────────

describe('checkCertExpiry (reader)', () => {
  it('returns info when HealthStore has no result yet', async () => {
    const out = await checkCertExpiry();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/has not run yet/);
  });

  it('decodes the runner-encoded payload (warn with items[])', async () => {
    const payload = {
      status: 'warn',
      detail: '1 of 1 Let\'s Encrypt cert expiring within 14 days.',
      hint: 'NPM auto-renews on a schedule.',
      items: [
        {
          id: '7',
          label: 'vault.example.com',
          detail: 'Expires in 3 days.',
          status: 'warn',
          actionIds: ['renew_cert'],
        },
      ],
    };
    state.results.set('cert_expiry', {
      check_id: 'cert_expiry',
      timestamp: new Date().toISOString(),
      status: 'ok',
      message: `cert_expiry:${JSON.stringify(payload)}`,
      latency: 100,
    });
    const out = await checkCertExpiry();
    expect(out.status).toBe('warn');
    expect(out.items).toHaveLength(1);
    expect(out.items?.[0].id).toBe('7'); // NPM cert id passed straight through to renew_cert action
    expect(out.items?.[0].actionIds).toEqual(['renew_cert']);
  });

  it('surfaces transport-error plaintext as info', async () => {
    state.results.set('cert_expiry', {
      check_id: 'cert_expiry',
      timestamp: new Date().toISOString(),
      status: 'fail',
      message: 'cert_expiry error: NPM unreachable',
      latency: 100,
    });
    const out = await checkCertExpiry();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/Check failed to run.*NPM unreachable/);
  });
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
