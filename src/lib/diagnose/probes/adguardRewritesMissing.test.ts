/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` hoists above any top-level `const`, so we can't reference
// shared state directly. Instead, expose state via getters and mock
// modules with closures that read those getters at call time.
const state = {
  config: {} as any,
  rewrites: [] as { domain: string; answer: string }[],
  provisionResult: { ok: true, detail: 'proxy:unchanged rewrites=*.dopp.cloud:unchanged' } as any,
  provisionThrows: null as Error | null,
};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));

vi.mock('@/lib/adguard/rewrites', () => ({
  listRewrites: vi.fn(() => Promise.resolve(state.rewrites)),
}));

vi.mock('@/lib/portal/provisioner', () => ({
  provisionPortalRouting: vi.fn(() => {
    if (state.provisionThrows) return Promise.reject(state.provisionThrows);
    return Promise.resolve(state.provisionResult);
  }),
}));

import { checkAdguardRewritesMissing } from './adguardRewritesMissing';
import { dispatchProbeAction } from '../actions';
import './adguardRewritesMissing';

beforeEach(() => {
  state.config = {
    installedTemplates: { adguard: { schemaVersion: 1, installedAt: '' } },
    adguard: { adminUrl: 'http://localhost:8083', username: 'admin', password: 'pw' },
    reverseProxy: { lanIp: '192.168.1.10', publicDomain: 'dopp.cloud' },
  };
  state.rewrites = [];
  state.provisionResult = { ok: true, detail: 'proxy:unchanged rewrites=*.dopp.cloud:unchanged' };
  state.provisionThrows = null;
});

describe('checkAdguardRewritesMissing', () => {
  it('returns ok when AdGuard is not installed', async () => {
    state.config = { installedTemplates: {} };
    const r = await checkAdguardRewritesMissing();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/not installed/);
  });

  it('returns info when AdGuard credentials are not recorded', async () => {
    state.config = {
      installedTemplates: { adguard: { schemaVersion: 1, installedAt: '' } },
      adguard: undefined,
      reverseProxy: { lanIp: '192.168.1.10' },
    };
    const r = await checkAdguardRewritesMissing();
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/credentials are not recorded/);
  });

  it('returns info when LAN IP is missing', async () => {
    state.config.reverseProxy = { publicDomain: 'dopp.cloud' };
    const r = await checkAdguardRewritesMissing();
    expect(r.status).toBe('info');
    expect(r.detail).toMatch(/LAN IP/);
  });

  it('warns when wildcard + apex rewrites are missing', async () => {
    state.rewrites = [];
    const r = await checkAdguardRewritesMissing();
    expect(r.status).toBe('warn');
    // Expected: home.arpa trio + dopp.cloud trio = 6 entries.
    expect(r.detail).toMatch(/6 missing/);
    expect(r.detail).toContain('*.dopp.cloud');
    expect(r.detail).toContain('*.home.arpa');
    expect(r.hint).toMatch(/Reprovision/);
  });

  it('warns when a rewrite points at the wrong IP', async () => {
    state.rewrites = [
      { domain: 'dopp.cloud', answer: '192.168.1.10' },
      { domain: 'www.dopp.cloud', answer: '192.168.1.10' },
      { domain: '*.dopp.cloud', answer: '10.0.0.1' }, // stale
      { domain: 'home.arpa', answer: '192.168.1.10' },
      { domain: 'www.home.arpa', answer: '192.168.1.10' },
      { domain: '*.home.arpa', answer: '192.168.1.10' },
    ];
    const r = await checkAdguardRewritesMissing();
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/pointing elsewhere/);
    expect(r.detail).toContain('*.dopp.cloud → 10.0.0.1');
  });

  it('returns ok when every expected rewrite is present and correct', async () => {
    state.rewrites = [
      { domain: 'dopp.cloud', answer: '192.168.1.10' },
      { domain: 'www.dopp.cloud', answer: '192.168.1.10' },
      { domain: '*.dopp.cloud', answer: '192.168.1.10' },
      { domain: 'home.arpa', answer: '192.168.1.10' },
      { domain: 'www.home.arpa', answer: '192.168.1.10' },
      { domain: '*.home.arpa', answer: '192.168.1.10' },
    ];
    const r = await checkAdguardRewritesMissing();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/6 portal\/wildcard rewrites in AdGuard point at 192\.168\.1\.10/);
  });

  it('skips the public domain when no public domain is configured (LAN-only mode)', async () => {
    state.config.reverseProxy = { lanIp: '192.168.1.10' }; // no publicDomain
    state.rewrites = [
      { domain: 'home.arpa', answer: '192.168.1.10' },
      { domain: 'www.home.arpa', answer: '192.168.1.10' },
      { domain: '*.home.arpa', answer: '192.168.1.10' },
    ];
    const r = await checkAdguardRewritesMissing();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/3 portal\/wildcard rewrites/);
  });
});

describe('adguard_rewrites_missing.reprovision', () => {
  it('returns ok and a details summary when provisionPortalRouting succeeds', async () => {
    const result = await dispatchProbeAction({
      probeId: 'adguard_rewrites_missing',
      actionId: 'reprovision',
      node: 'Local',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/reprovisioned/);
    expect(result.details).toBe('proxy:unchanged rewrites=*.dopp.cloud:unchanged');
    expect(result.refresh).toBe(true);
  });

  it('surfaces the structured detail when the provisioner reports partial failure', async () => {
    state.provisionResult = { ok: false, detail: 'proxy:failed rewrites=*.dopp.cloud:failed' };
    const result = await dispatchProbeAction({
      probeId: 'adguard_rewrites_missing',
      actionId: 'reprovision',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/finished with errors/);
    expect(result.details).toContain('failed');
  });

  it('returns ok=false when the provisioner throws', async () => {
    state.provisionThrows = new Error('AdGuard unreachable');
    const result = await dispatchProbeAction({
      probeId: 'adguard_rewrites_missing',
      actionId: 'reprovision',
      node: 'Local',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('AdGuard unreachable');
  });
});
