/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// State the mocks read, reset per test.
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

const ensureWildcardRewrite = vi.fn();
vi.mock('@/lib/adguard/rewrites', () => ({
  ensureWildcardRewrite: (...args: any[]) => ensureWildcardRewrite(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { provisionPortalRouting } from './provisioner';

const PUBLIC_CONFIG = {
  reverseProxy: { lanIp: '192.168.178.100', publicDomain: 'dopp.cloud' },
};

beforeEach(() => {
  state.config = JSON.parse(JSON.stringify(PUBLIC_CONFIG));
  state.services = [];
  ensureWildcardRewrite.mockReset();
  mockFetch.mockReset();
});

describe('provisionPortalRouting', () => {
  it('reports skipped (not failed) on a fresh install with no nginx and no AdGuard', async () => {
    // Nothing deployed: no nginx → proxy skipped; no AdGuard service +
    // no creds → rewrites skipped. The "did not provision" alarm must
    // NOT fire on a healthy minimal box.
    const res = await provisionPortalRouting();
    expect(res.ok).toBe(true);
    expect(res.proxyHost).toBe('skipped');
    expect(Object.values(res.rewrites!)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(res.detail).toMatch(/nothing to wire up/i);
    expect(ensureWildcardRewrite).not.toHaveBeenCalled();
  });

  it('reports failed (worth retrying) when AdGuard is part of the install but not ready yet', async () => {
    // AdGuard deployed but still cold-starting (active:false) and no creds
    // written yet → a real, transient condition the retry loop should keep
    // hitting. Existence, not active-state, is what marks it as "ours".
    state.services = [{ name: 'adguard', active: false }];
    const res = await provisionPortalRouting();
    expect(res.ok).toBe(false);
    expect(Object.values(res.rewrites!)).toEqual(['failed', 'failed', 'failed']);
    expect(res.detail).toContain('dopp.cloud:failed');
    expect(res.detail).not.toMatch(/nothing to wire up/i);
  });

  it('reports proxy failed (not skipped) when nginx is installed but not yet active', async () => {
    // The reverse proxy was installed but is still starting — must not be
    // reported as "nothing to wire up".
    state.services = [{ name: 'nginx', active: false }];
    const res = await provisionPortalRouting();
    expect(res.ok).toBe(false);
    expect(res.proxyHost).toBe('failed');
    expect(res.detail).not.toMatch(/nothing to wire up/i);
  });

  it('writes the apex/www/wildcard rewrites once AdGuard creds are present', async () => {
    state.config.adguard = { password: 'pw', username: 'admin', adminUrl: 'http://localhost:8083' };
    ensureWildcardRewrite.mockResolvedValue('added');
    const res = await provisionPortalRouting();
    expect(res.ok).toBe(true);
    expect(ensureWildcardRewrite).toHaveBeenCalledTimes(3);
    expect(ensureWildcardRewrite).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'pw' }),
      'dopp.cloud',
      '192.168.178.100',
    );
    expect(res.rewrites).toEqual({ 'dopp.cloud': 'added', 'www.dopp.cloud': 'added', '*.dopp.cloud': 'added' });
  });
});
