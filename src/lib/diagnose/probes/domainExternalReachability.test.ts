/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckConfig, CheckResult } from '@/lib/health/types';

const state = {
  config: {} as any,
  checks: [] as CheckConfig[],
  results: new Map<string, CheckResult>(),
  runOutcome: { status: 'ok' as 'ok' | 'fail', message: '' as string },
  runCallCount: 0,
};

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(() => Promise.resolve(state.config)),
}));

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getChecks: () => state.checks,
    getLastResult: (id: string) => state.results.get(id) ?? null,
    saveResult: (r: CheckResult) => state.results.set(r.check_id, r),
  },
}));

vi.mock('@/lib/health/runner', () => ({
  LETSDEBUG_MESSAGE_PREFIX: 'letsdebug:',
  CheckRunner: {
    run: vi.fn((check: CheckConfig) => {
      state.runCallCount++;
      const result: CheckResult = {
        check_id: check.id,
        timestamp: new Date().toISOString(),
        status: state.runOutcome.status,
        message: state.runOutcome.message,
        latency: 100,
      };
      state.results.set(check.id, result);
      return Promise.resolve(result);
    }),
  },
}));

import {
  checkDomainExternalReachability,
  _internalsForTesting,
} from './domainExternalReachability';
import { dispatchProbeAction } from '../actions';

const NOW = Date.UTC(2026, 4, 14, 12, 0, 0);

const isoNow = () => new Date(NOW).toISOString();
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  state.config = {
    reverseProxy: {
      hosts: [
        { domain: 'one.example.com', exposure: 'public' },
        { domain: 'two.example.com', exposure: 'public' },
      ],
    },
  };
  state.checks = [
    {
      id: 'letsdebug:one.example.com',
      name: 'External reachability — one.example.com',
      type: 'letsdebug',
      target: 'one.example.com',
      interval: 14400,
      enabled: true,
      created_at: isoNow(),
    },
    {
      id: 'letsdebug:two.example.com',
      name: 'External reachability — two.example.com',
      type: 'letsdebug',
      target: 'two.example.com',
      interval: 14400,
      enabled: true,
      created_at: isoNow(),
    },
  ];
  state.results = new Map();
  state.runOutcome = { status: 'ok', message: '' };
  state.runCallCount = 0;
});

describe('checkDomainExternalReachability', () => {
  it('renders "First check pending" when HealthStore has no result yet', async () => {
    const result = await checkDomainExternalReachability();
    expect(result.items).toHaveLength(2);
    expect(result.items![0].detail).toMatch(/First check pending/);
    expect(result.items![0].actionIds).toContain('refresh_now');
    expect(result.detail).toMatch(/pending/);
  });

  it('omits the row for a healthy domain (ok + empty message)', async () => {
    state.results.set('letsdebug:one.example.com', {
      check_id: 'letsdebug:one.example.com',
      timestamp: isoAgo(15 * 60_000), // 15 min ago
      status: 'ok',
      message: '',
      latency: 200,
    });
    // two.example.com has no result → pending row.
    const result = await checkDomainExternalReachability();
    const rows = result.items?.map(i => i.id);
    expect(rows).not.toContain('one.example.com');
    expect(rows).toContain('two.example.com');
  });

  it('renders a problem row with last-checked + Report URL for an encoded payload', async () => {
    const payload = JSON.stringify({
      problems: [{ name: 'IssueX', explanation: 'thing broke', severity: 'warning' }],
      submissionUrl: 'https://letsdebug.net/?id=1',
    });
    state.results.set('letsdebug:one.example.com', {
      check_id: 'letsdebug:one.example.com',
      timestamp: isoAgo(12 * 60_000), // 12 min ago
      status: 'ok',
      message: `letsdebug:${payload}`,
      latency: 200,
    });
    const result = await checkDomainExternalReachability();
    const row = result.items?.find(i => i.id === 'one.example.com');
    expect(row).toBeDefined();
    expect(row!.detail).toMatch(/IssueX: thing broke/);
    expect(row!.detail).toMatch(/Report: https/);
    expect(row!.detail).toMatch(/Last checked 12 min ago/);
    expect(row!.status).toBe('warn');
    expect(row!.actionIds).toContain('refresh_now');
  });

  it('escalates to fail when any problem is severity=fatal', async () => {
    const payload = JSON.stringify({
      problems: [{ name: 'IssueY', explanation: 'really broken', severity: 'fatal' }],
      submissionUrl: null,
    });
    state.results.set('letsdebug:one.example.com', {
      check_id: 'letsdebug:one.example.com',
      timestamp: isoNow(),
      status: 'fail',
      message: `letsdebug:${payload}`,
      latency: 200,
    });
    const result = await checkDomainExternalReachability();
    const row = result.items?.find(i => i.id === 'one.example.com');
    expect(row!.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  it('renders a transport-error row for a plaintext fail message', async () => {
    state.results.set('letsdebug:one.example.com', {
      check_id: 'letsdebug:one.example.com',
      timestamp: isoAgo(2 * 60_000),
      status: 'fail',
      message: 'letsdebug error: HTTP 429',
      latency: 200,
    });
    const result = await checkDomainExternalReachability();
    const row = result.items?.find(i => i.id === 'one.example.com');
    expect(row).toBeDefined();
    expect(row!.detail).toMatch(/could not run automatically/);
    expect(row!.detail).toMatch(/HTTP 429/);
    expect(row!.detail).toMatch(/Last checked 2 min ago/);
    expect(row!.actionIds).toContain('refresh_now');
  });

  it('returns ok when no public domains are configured', async () => {
    state.config = { reverseProxy: { hosts: [] } };
    const result = await checkDomainExternalReachability();
    expect(result.status).toBe('ok');
    expect(result.items).toBeUndefined();
  });
});

describe('refresh_now action', () => {
  it('runs the matching health check and reports the result', async () => {
    state.runOutcome = { status: 'ok', message: '' };
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now',
      node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/reachable/);
    expect(state.runCallCount).toBe(1);
  });

  it('reports problem count when the check finds issues', async () => {
    const payload = JSON.stringify({
      problems: [
        { name: 'A', explanation: 'a', severity: 'warning' },
        { name: 'B', explanation: 'b', severity: 'warning' },
      ],
      submissionUrl: null,
    });
    state.runOutcome = { status: 'ok', message: `letsdebug:${payload}` };
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now',
      node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/2 problem/);
  });

  it('surfaces transport errors and still refreshes the UI', async () => {
    state.runOutcome = { status: 'fail', message: 'letsdebug error: timeout' };
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now',
      node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/timeout/);
    expect(r.refresh).toBe(true);
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

  it('returns ok:false when the check does not exist', async () => {
    state.checks = []; // no checks at all
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now',
      node: 'Local',
      itemId: 'missing.example.com',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No external-reachability check/);
  });
});

describe('formatRelativeAge', () => {
  const { formatRelativeAge } = _internalsForTesting;
  const NOW2 = Date.UTC(2026, 4, 14, 12, 0, 0);
  it('renders "just now" for <30s', () => {
    expect(formatRelativeAge(NOW2 - 5_000, NOW2)).toBe('just now');
  });
  it('renders seconds for <60s', () => {
    expect(formatRelativeAge(NOW2 - 45_000, NOW2)).toBe('45 s ago');
  });
  it('renders minutes for <1h', () => {
    expect(formatRelativeAge(NOW2 - 12 * 60_000, NOW2)).toBe('12 min ago');
  });
  it('renders hours for <24h', () => {
    expect(formatRelativeAge(NOW2 - 5 * 60 * 60_000, NOW2)).toBe('5 h ago');
  });
  it('renders days otherwise', () => {
    expect(formatRelativeAge(NOW2 - 3 * 24 * 60 * 60_000, NOW2)).toBe('3 d ago');
  });
});
