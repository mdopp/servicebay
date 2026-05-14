/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  config: {} as any,
  // Each call to `runLetsdebugForDomain` returns the next queued
  // result, then sticks on the last one if the queue runs dry.
  letsdebugResults: [] as Array<{ problems: Array<{ name: string; explanation: string; severity?: string }>; submissionUrl: string | null }>,
  letsdebugThrows: null as Error | null,
  callsByDomain: new Map<string, number>(),
};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));

vi.mock('../../letsdebug/client', () => ({
  runLetsdebugForDomain: vi.fn((domain: string) => {
    state.callsByDomain.set(domain, (state.callsByDomain.get(domain) ?? 0) + 1);
    if (state.letsdebugThrows) return Promise.reject(state.letsdebugThrows);
    const next = state.letsdebugResults.shift() ?? state.letsdebugResults[0] ?? { problems: [], submissionUrl: null };
    return Promise.resolve(next);
  }),
}));

// Importing the probe module also runs `registerProbeAction` for
// `refresh_now`, which lives in the singleton registry — fine across
// tests since the registration is idempotent within a single import.
import {
  checkDomainExternalReachability,
  forceRefreshDomain,
  _resetCacheForTesting,
} from './domainExternalReachability';
import { dispatchProbeAction } from '../actions';

beforeEach(() => {
  state.config = {
    reverseProxy: {
      hosts: [
        { domain: 'one.example.com', exposure: 'public' },
        { domain: 'two.example.com', exposure: 'public' },
      ],
    },
  };
  state.letsdebugResults = [];
  state.letsdebugThrows = null;
  state.callsByDomain.clear();
  _resetCacheForTesting();
});

describe('checkDomainExternalReachability', () => {
  it('renders "Last checked X ago" suffix on rows with cache data', async () => {
    state.letsdebugResults = [
      { problems: [{ name: 'IssueX', explanation: 'thing broke', severity: 'warning' }], submissionUrl: 'https://letsdebug.net/?id=1' },
    ];
    await forceRefreshDomain('one.example.com');

    const result = await checkDomainExternalReachability();
    const item = result.items?.find(i => i.id === 'one.example.com');
    expect(item).toBeDefined();
    expect(item!.detail).toMatch(/Last checked /);
    expect(item!.detail).toMatch(/IssueX: thing broke/);
  });

  it('offers refresh_now action on queued rows (no cache yet)', async () => {
    const result = await checkDomainExternalReachability();
    const queued = result.items?.find(i => i.id === 'one.example.com');
    expect(queued).toBeDefined();
    expect(queued!.actionIds).toContain('refresh_now');
  });

  it('offers refresh_now action on rows with a cached problem', async () => {
    state.letsdebugResults = [
      { problems: [{ name: 'IssueY', explanation: 'still broken', severity: 'fatal' }], submissionUrl: null },
    ];
    await forceRefreshDomain('two.example.com');
    // Reset the background-sweep state so the next `check` call doesn't
    // race against an in-flight sweep that would overwrite our seeded
    // cache for the other domain.
    const after = await checkDomainExternalReachability();
    const cached = after.items?.find(i => i.id === 'two.example.com');
    expect(cached).toBeDefined();
    expect(cached!.actionIds).toContain('refresh_now');
  });

  it('does not crash and renders queued rows when the cache is empty', async () => {
    const result = await checkDomainExternalReachability();
    // Both domains have no cache → both render as queued or probing
    // rows, and the overall detail mentions queued count.
    expect(result.items).toHaveLength(2);
    expect(result.detail).toMatch(/queued/i);
  });
});

describe('refresh_now action', () => {
  it('runs the probe and reports a healthy result', async () => {
    state.letsdebugResults = [
      { problems: [], submissionUrl: 'https://letsdebug.net/?id=42' },
    ];
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now',
      node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/reachable/);
    expect(r.refresh).toBe(true);
    expect(state.callsByDomain.get('one.example.com')).toBe(1);
  });

  it('reports problem counts when letsdebug finds issues', async () => {
    state.letsdebugResults = [
      {
        problems: [
          { name: 'IssueA', explanation: 'a', severity: 'fatal' },
          { name: 'IssueB', explanation: 'b', severity: 'warning' },
        ],
        submissionUrl: null,
      },
    ];
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now',
      node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/2 problem/);
  });

  it('returns ok:false when no domain is supplied', async () => {
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now',
      node: 'Local',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No domain/);
  });

  it('surfaces a clear error message and still refreshes the UI on transport failure', async () => {
    state.letsdebugThrows = new Error('HTTP 429 — too many requests');
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now',
      node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/429/);
    // We still want a UI refresh so the row's "letsdebug probe could
    // not run automatically" detail renders.
    expect(r.refresh).toBe(true);
  });
});
