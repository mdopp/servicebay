/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckConfig, CheckResult } from '@/lib/health/types';

const state = {
  config: {} as any,
  checks: [] as CheckConfig[],
  results: new Map<string, CheckResult>(),
  runOutcome: { status: 'ok' as 'ok' | 'fail', message: '' as string, payload: undefined as unknown },
  runCallCount: 0,
  letsdebugCalls: [] as string[],
  letsdebugResult: undefined as
    | { problems: { name?: string; explanation?: string; severity?: string }[]; submissionUrl: string }
    | undefined,
  letsdebugError: undefined as Error | undefined,
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
  CheckRunner: {
    run: vi.fn((check: CheckConfig) => {
      state.runCallCount++;
      const result: CheckResult = {
        check_id: check.id,
        timestamp: new Date().toISOString(),
        status: state.runOutcome.status,
        message: state.runOutcome.message,
        payload: state.runOutcome.payload,
        latency: 5,
      };
      state.results.set(check.id, result);
      return Promise.resolve(result);
    }),
  },
}));

vi.mock('@/lib/letsdebug/client', () => ({
  runLetsdebugForDomain: vi.fn((domain: string) => {
    state.letsdebugCalls.push(domain);
    if (state.letsdebugError) return Promise.reject(state.letsdebugError);
    return Promise.resolve(state.letsdebugResult);
  }),
}));

import {
  checkDomainExternalReachability,
  _internalsForTesting,
} from './domainExternalReachability';
import { dispatchProbeAction } from '../actions';

const NOW = Date.UTC(2026, 4, 15, 12, 0, 0);
const isoNow = () => new Date(NOW).toISOString();
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();

// #1564 — the per-domain dns_routing rows collapsed into the canonical
// `domain` check, which carries the DoH DNS-routing payload on its result.
function makeDomainCheck(domain: string): CheckConfig {
  return {
    id: `domain:${domain}`,
    name: `Domain — ${domain}`,
    type: 'domain',
    target: domain,
    interval: 60,
    enabled: true,
    created_at: isoNow(),
    domainConfig: { expectedScheme: 'https', isPublic: true },
  };
}

function dnsRoutingPayload(opts: { expected: string | null; resolved: string[]; matched: boolean }) {
  return opts;
}

function letsdebugPayload(problems: { name?: string; explanation?: string; severity?: string }[], submissionUrl = 'https://letsdebug.net/x.example.com/1') {
  return { problems, submissionUrl };
}

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
    makeDomainCheck('one.example.com'),
    makeDomainCheck('two.example.com'),
  ];
  state.results.clear();
  state.runOutcome = { status: 'ok', message: '', payload: undefined };
  state.runCallCount = 0;
  state.letsdebugCalls = [];
  state.letsdebugResult = { problems: [], submissionUrl: 'https://letsdebug.net/one.example.com/42' };
  state.letsdebugError = undefined;
  // #611 — the probe now does an HTTPS GET per public domain. Stub
  // global fetch so existing tests don't hit the network and so the
  // HTTP layer reports `ok` by default (existing DNS-focused tests
  // were written against an HTTP-less world).
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 200 }) as Response,
  );
});

describe('checkDomainExternalReachability', () => {
  it('returns ok with empty detail when no public hosts are configured', async () => {
    state.config = { reverseProxy: { hosts: [{ domain: 'lan-only.home.arpa' }] } };
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/No public domains configured/);
    expect(r.items).toBeUndefined();
  });

  it('reports `info` + pending row when the dns_routing check has not yet run', async () => {
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('info');
    expect(r.items).toHaveLength(2);
    expect(r.items![0].status).toBe('info');
    expect(r.items![0].detail).toMatch(/First check pending/);
    expect(r.items![0].actionIds).toEqual(['refresh_now', 'run_letsdebug']);
  });

  it('omits healthy rows when DNS matches the gateway IP and reports overall ok', async () => {
    state.results.set('domain:one.example.com', {
      check_id: 'domain:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    state.results.set('domain:two.example.com', {
      check_id: 'domain:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('ok');
    expect(r.items).toBeUndefined();
    expect(r.detail).toMatch(/2 public domains resolving to your public IP/);
  });

  it('flags a domain whose A record points at a different IP as fail', async () => {
    state.results.set('domain:one.example.com', {
      check_id: 'domain:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'fail',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['198.51.100.7'], matched: false }),
    });
    state.results.set('domain:two.example.com', {
      check_id: 'domain:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('fail');
    expect(r.items).toHaveLength(1);
    expect(r.items![0].id).toBe('one.example.com');
    expect(r.items![0].detail).toMatch(/198\.51\.100\.7/);
    expect(r.items![0].detail).toMatch(/your gateway IP is 203\.0\.113\.5/);
  });

  it('flags a domain with no public A record as fail', async () => {
    state.results.set('domain:one.example.com', {
      check_id: 'domain:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'fail',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: [], matched: false }),
    });
    state.results.set('domain:two.example.com', {
      check_id: 'domain:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('fail');
    expect(r.items).toHaveLength(1);
    expect(r.items![0].detail).toMatch(/no A record/);
  });

  it('surfaces transport errors (no payload, fail status) as info rows', async () => {
    state.results.set('domain:one.example.com', {
      check_id: 'domain:one.example.com',
      timestamp: isoAgo(30_000),
      status: 'fail',
      message: 'DoH lookup failed: connect ETIMEDOUT',
    });
    state.results.set('domain:two.example.com', {
      check_id: 'domain:two.example.com',
      timestamp: isoAgo(30_000),
      status: 'ok',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    const r = await checkDomainExternalReachability();
    expect(r.items).toHaveLength(1);
    expect(r.items![0].status).toBe('info');
    expect(r.items![0].detail).toMatch(/DNS check could not run/);
  });

  it('is DNS-routing only — DNS-green is ok and it does NO per-domain HTTP fetch', async () => {
    // The flaky/redundant per-domain HTTPS GET (old #611) was removed: it
    // false-timed-out under concurrent diagnose load and duplicated the upstream
    // check that `domain_unreachable` already does via a Host-header fetch. This
    // probe now judges DNS routing only; a DNS-green domain is ok regardless of
    // upstream HTTP, and crucially it makes no outbound fetch (no cry-wolf).
    state.config.reverseProxy.publicDomain = 'example.com';
    for (const d of ['one.example.com', 'two.example.com']) {
      state.results.set(`domain:${d}`, {
        check_id: `domain:${d}`,
        timestamp: isoAgo(60_000),
        status: 'ok',
        payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
      });
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('ok');
    expect(r.items).toBeUndefined(); // healthy DNS-green rows collapse
    expect(fetchSpy).not.toHaveBeenCalled(); // no flaky per-domain HTTP GET
  });

  it('appends letsdebug summary to a flagged row when one exists', async () => {
    state.results.set('domain:one.example.com', {
      check_id: 'domain:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'fail',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['198.51.100.7'], matched: false }),
    });
    state.results.set('letsdebug:one.example.com', {
      check_id: 'letsdebug:one.example.com',
      timestamp: isoAgo(120_000),
      status: 'fail',
      payload: letsdebugPayload([{ name: 'ANotWorking', explanation: 'port 80 unreachable', severity: 'fatal' }]),
    });
    state.results.set('domain:two.example.com', {
      check_id: 'domain:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    const r = await checkDomainExternalReachability();
    expect(r.items).toHaveLength(1);
    expect(r.items![0].detail).toMatch(/ANotWorking/);
    expect(r.items![0].detail).toMatch(/port 80 unreachable/);
  });
});

describe('refresh_now action (DoH)', () => {
  it('runs the dns_routing check and reports matched=true', async () => {
    state.runOutcome = {
      status: 'ok',
      message: '',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    };
    const r = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'refresh_now', node: 'Local',
      itemId: 'one.example.com',
    });
    expect(state.runCallCount).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/matches your gateway/);
    expect(r.refresh).toBe(true);
  });

  it('reports ok:false when DNS does not match', async () => {
    state.runOutcome = {
      status: 'fail',
      message: '',
      payload: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['198.51.100.7'], matched: false }),
    };
    const r = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'refresh_now', node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/198\.51\.100\.7/);
  });

  it('reports ok:false when the matching check does not exist', async () => {
    state.checks = state.checks.filter(c => c.id !== 'domain:one.example.com');
    const r = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'refresh_now', node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No domain check found/);
  });
});

describe('run_letsdebug action', () => {
  it('invokes letsdebug client and saves the result', async () => {
    state.letsdebugResult = { problems: [], submissionUrl: 'https://letsdebug.net/one.example.com/99' };
    const r = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'run_letsdebug', node: 'Local',
      itemId: 'one.example.com',
    });
    expect(state.letsdebugCalls).toEqual(['one.example.com']);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/passed letsdebug/);
    const saved = state.results.get('letsdebug:one.example.com');
    expect(saved).toBeDefined();
    expect((saved!.payload as { problems: unknown[] }).problems).toEqual([]);
  });

  it('surfaces a friendly 429 message when letsdebug rate-limits', async () => {
    state.letsdebugError = new Error('letsdebug submission HTTP 429');
    const r = await dispatchProbeAction({
      probeId: 'domain_unreachable',
      actionId: 'run_letsdebug', node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rate-limited/);
    // Saved as a transport-error result so the row shows "last run failed".
    expect(state.results.get('letsdebug:one.example.com')?.status).toBe('fail');
  });
});

describe('_internalsForTesting', () => {
  it('decodes dns_routing payload', () => {
    const p = _internalsForTesting.decodeDnsRouting(
      dnsRoutingPayload({ expected: '1.1.1.1', resolved: ['1.1.1.1'], matched: true }),
    );
    expect(p?.matched).toBe(true);
    expect(p?.expected).toBe('1.1.1.1');
  });

  it('returns null for a plaintext message', () => {
    expect(_internalsForTesting.decodeDnsRouting('connect ETIMEDOUT')).toBeNull();
  });
});
