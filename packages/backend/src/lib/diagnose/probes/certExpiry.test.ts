/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckResult } from '@/lib/health/types';

const state = {
  config: {} as any,
  services: [] as any[],
  results: new Map<string, CheckResult>(),
  checks: [{ id: 'cert_expiry' }] as Array<{ id: string }>,
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
    getChecks: () => state.checks,
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { dispatchProbeAction, actionsForProbe } from '../actions';
import { checkCertExpiry } from './certExpiry';
import './certExpiry';
import { CERT_EXPIRY_ACTION_IDS } from '@/lib/health/probes/certExpiry';

const ACTIVE_NGINX = [{ name: 'nginx', active: true, ports: [{ host: '8081', container: '81' }] }];

const BOUND_HOST = [{ id: 1, certificate_id: 7, domain_names: ['vault.example.com'] }];

/** Answer NPM by URL instead of by call order — both cert actions now
 *  re-read the cert + the proxy-host table before they act, so a fixed
 *  `mockResolvedValueOnce` chain would encode call order as if it were
 *  behaviour. */
function npm(opts: {
  token?: boolean;
  cert?: { id: number; domain_names?: string[] } | 'missing' | 'error';
  hosts?: unknown[] | 'error';
  renew?: { ok: boolean; status?: number; body?: string };
  del?: { ok: boolean; status?: number; body?: string };
} = {}) {
  mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    const u = String(url);
    if (u.endsWith('/api/tokens')) {
      return opts.token === false
        ? { ok: false, status: 401, json: async () => ({}) }
        : { ok: true, json: async () => ({ token: 'tok' }) };
    }
    if (u.includes('/renew')) {
      return { ok: opts.renew?.ok ?? true, status: opts.renew?.status ?? 200, text: async () => opts.renew?.body ?? '' };
    }
    if (u.includes('/api/nginx/proxy-hosts')) {
      return opts.hosts === 'error'
        ? { ok: false, status: 500 }
        : { ok: true, json: async () => opts.hosts ?? BOUND_HOST };
    }
    if (u.includes('/api/nginx/certificates/')) {
      if (init?.method === 'DELETE') {
        return { ok: opts.del?.ok ?? true, status: opts.del?.status ?? 200, text: async () => opts.del?.body ?? '' };
      }
      if (opts.cert === 'missing') return { ok: false, status: 404 };
      if (opts.cert === 'error') return { ok: false, status: 502 };
      return { ok: true, json: async () => opts.cert ?? { id: 7, domain_names: ['vault.example.com'] } };
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

const called = (fragment: string, method?: string) =>
  mockFetch.mock.calls.some(
    ([url, init]) => String(url).includes(fragment) && (!method || (init as { method?: string })?.method === method),
  );

beforeEach(() => {
  state.config = { reverseProxy: { npm: { email: 'a@b.c', password: 'pw' } } };
  state.services = ACTIVE_NGINX;
  state.results = new Map();
  state.checks = [{ id: 'cert_expiry' }];
  mockFetch.mockReset();
});

// ─── Reader (Phase 3b: thin HealthStore reader) ─────────────────────────

describe('checkCertExpiry (reader)', () => {
  it('returns info when HealthStore has no result yet (check exists, first run pending)', async () => {
    const out = await checkCertExpiry();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/first run pending/);
  });

  it('reports the missing-prereq state when the cert_expiry check has not been created yet (#664)', async () => {
    state.checks = [];
    const out = await checkCertExpiry();
    expect(out.status).toBe('info');
    expect(out.detail).toMatch(/No proxy hosts with public exposure/);
  });

  it('reads the typed runner payload (warn with items[])', async () => {
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
      payload,
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
    npm();
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      itemId: '7',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Renewal triggered for cert 7/);
    expect(called('/api/nginx/certificates/7/renew', 'POST')).toBe(true);
  });

  it('surfaces NPM HTTP error on renewal failure', async () => {
    npm({ renew: { ok: false, status: 500, body: 'challenge failed' } });
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
    npm({ token: false });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      itemId: '7',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/authenticate/);
  });

  it('refuses to renew a cert no proxy host uses, without firing the ACME attempt (#2594)', async () => {
    npm({ cert: { id: 11, domain_names: ['books.example.com'] }, hosts: [] });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      itemId: '11',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/books\.example\.com/);
    expect(result.message).toMatch(/Delete certificate/);
    // The point of refusing up front: no failed renewal to resurface
    // under cert_request_failure, no wasted Let's Encrypt attempt.
    expect(called('/renew')).toBe(false);
  });

  it('renews as before when the binding state cannot be read', async () => {
    npm({ hosts: 'error' });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'renew_cert',
      itemId: '7',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(called('/api/nginx/certificates/7/renew', 'POST')).toBe(true);
  });
});

describe('cert_expiry.delete_orphaned_cert (#2594)', () => {
  it('deletes a cert that no proxy host binds', async () => {
    npm({ cert: { id: 11, domain_names: ['books.example.com'] }, hosts: [] });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'delete_orphaned_cert',
      itemId: '11',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/books\.example\.com/);
    expect(called('/api/nginx/certificates/11', 'DELETE')).toBe(true);
  });

  it('refuses when a proxy host has meanwhile started using the cert', async () => {
    // The row the operator clicked can be up to an hour old.
    npm({ cert: { id: 7, domain_names: ['vault.example.com'] }, hosts: BOUND_HOST });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'delete_orphaned_cert',
      itemId: '7',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/still uses this certificate/);
    expect(called('/api/nginx/certificates/7', 'DELETE')).toBe(false);
  });

  it('refuses when the binding state cannot be established at all', async () => {
    npm({ cert: { id: 11, domain_names: ['books.example.com'] }, hosts: 'error' });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'delete_orphaned_cert',
      itemId: '11',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Not deleting/);
    expect(called('/api/nginx/certificates/11', 'DELETE')).toBe(false);
  });

  it('refuses a non-numeric id before touching NPM', async () => {
    npm();
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'delete_orphaned_cert',
      itemId: '../7',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('surfaces an NPM HTTP error from the delete', async () => {
    npm({ cert: { id: 11, domain_names: ['books.example.com'] }, hosts: [], del: { ok: false, status: 500 } });
    const result = await dispatchProbeAction({
      probeId: 'cert_expiry',
      actionId: 'delete_orphaned_cert',
      itemId: '11',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/HTTP 500/);
  });
});

describe('cert_expiry action wiring', () => {
  it('registers a handler for every action id the health probe can emit', () => {
    // The emitting side (health probe) and the handling side (here) are
    // two files. An id emitted with no handler behind it is dropped by
    // resolveItemActions, i.e. the row renders a fix with no button.
    const registered = actionsForProbe('cert_expiry').map(a => a.id);
    for (const id of Object.values(CERT_EXPIRY_ACTION_IDS)) {
      expect(registered).toContain(id);
    }
  });

  it('marks the delete action destructive so the UI confirms first', () => {
    const del = actionsForProbe('cert_expiry').find(a => a.id === CERT_EXPIRY_ACTION_IDS.deleteOrphaned)!;
    expect(del.destructive).toBe(true);
    expect(del.label).toBe('Delete certificate');
  });
});
