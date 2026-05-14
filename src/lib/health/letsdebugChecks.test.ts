/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckConfig } from './types';

const state = {
  config: {} as any,
  checks: [] as CheckConfig[],
  saved: [] as CheckConfig[],
  deleted: [] as string[],
};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));

vi.mock('./store', () => ({
  HealthStore: {
    getChecks: () => state.checks,
    saveCheck: (c: CheckConfig) => {
      state.saved.push(c);
      const i = state.checks.findIndex(x => x.id === c.id);
      if (i >= 0) state.checks[i] = c; else state.checks.push(c);
    },
    deleteCheck: (id: string) => {
      state.deleted.push(id);
      state.checks = state.checks.filter(c => c.id !== id);
    },
  },
}));

import { syncLetsdebugChecks } from './letsdebugChecks';

beforeEach(() => {
  state.config = { reverseProxy: { hosts: [] } };
  state.checks = [];
  state.saved = [];
  state.deleted = [];
});

describe('syncLetsdebugChecks', () => {
  it('creates one letsdebug:<domain> check per public host', async () => {
    state.config = {
      reverseProxy: {
        hosts: [
          { domain: 'public.example.com', exposure: 'public' },
          { domain: 'lan-only.home.arpa' },
          { domain: 'auto-public.example.org' },
        ],
      },
    };
    await syncLetsdebugChecks();
    const ids = state.saved.map(c => c.id).sort();
    expect(ids).toEqual([
      'letsdebug:auto-public.example.org',
      'letsdebug:public.example.com',
    ]);
    for (const c of state.saved) {
      expect(c.type).toBe('letsdebug');
      expect(c.interval).toBe(14400);
      expect(c.enabled).toBe(true);
    }
  });

  it('skips LAN-only domains', async () => {
    state.config = {
      reverseProxy: {
        hosts: [{ domain: 'node.home.arpa' }, { domain: 'server.local' }],
      },
    };
    await syncLetsdebugChecks();
    expect(state.saved).toHaveLength(0);
  });

  it('respects exposure:"lan" override on a public-shaped domain', async () => {
    state.config = {
      reverseProxy: {
        hosts: [{ domain: 'private.example.com', exposure: 'lan' }],
      },
    };
    await syncLetsdebugChecks();
    expect(state.saved).toHaveLength(0);
  });

  it('does not re-save an existing identical check (preserves history)', async () => {
    const existing: CheckConfig = {
      id: 'letsdebug:public.example.com',
      name: 'External reachability — public.example.com',
      type: 'letsdebug',
      target: 'public.example.com',
      interval: 14400,
      enabled: true,
      created_at: '2026-01-01T00:00:00Z',
      nodeName: 'Local',
    };
    state.checks = [existing];
    state.config = {
      reverseProxy: {
        hosts: [{ domain: 'public.example.com', exposure: 'public' }],
      },
    };
    await syncLetsdebugChecks();
    expect(state.saved).toHaveLength(0);
  });

  it('removes orphans when a host is deleted', async () => {
    state.checks = [{
      id: 'letsdebug:gone.example.com',
      name: 'External reachability — gone.example.com',
      type: 'letsdebug',
      target: 'gone.example.com',
      interval: 14400,
      enabled: true,
      created_at: '2026-01-01T00:00:00Z',
    }];
    state.config = { reverseProxy: { hosts: [] } };
    await syncLetsdebugChecks();
    expect(state.deleted).toEqual(['letsdebug:gone.example.com']);
  });

  it('removes the orphan when a host flips public → lan', async () => {
    state.checks = [{
      id: 'letsdebug:flipped.example.com',
      name: 'External reachability — flipped.example.com',
      type: 'letsdebug',
      target: 'flipped.example.com',
      interval: 14400,
      enabled: true,
      created_at: '2026-01-01T00:00:00Z',
    }];
    state.config = {
      reverseProxy: {
        hosts: [{ domain: 'flipped.example.com', exposure: 'lan' }],
      },
    };
    await syncLetsdebugChecks();
    expect(state.deleted).toContain('letsdebug:flipped.example.com');
  });

  it('does not touch unrelated check types', async () => {
    state.checks = [
      { id: 'http:my-svc', name: 'HTTP', type: 'http', target: 'http://localhost', interval: 60, enabled: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 'domain:public.example.com', name: 'Domain', type: 'domain', target: 'public.example.com', interval: 60, enabled: true, created_at: '2026-01-01T00:00:00Z' },
    ];
    state.config = { reverseProxy: { hosts: [] } };
    await syncLetsdebugChecks();
    expect(state.deleted).toHaveLength(0);
  });
});
