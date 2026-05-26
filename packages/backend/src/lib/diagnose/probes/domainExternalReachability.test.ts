/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckConfig, CheckResult } from '@/lib/health/types';

const state = {
  config: {} as any,
  checks: [] as CheckConfig[],
  results: new Map<string, CheckResult>(),
  runOutcome: { status: 'ok' as 'ok' | 'fail', message: '' as string },
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
  DNS_ROUTING_MESSAGE_PREFIX: 'dns_routing:',
  LETSDEBUG_MESSAGE_PREFIX: 'letsdebug:',
  CheckRunner: {
    run: vi.fn((check: CheckConfig) => {
      state.runCallCount++;
      const result: CheckResult = {
        check_id: check.id,
        timestamp: new Date().toISOString(),
        status: state.runOutcome.status,
        message: state.runOutcome.message,
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

function makeDnsRoutingCheck(domain: string): CheckConfig {
  return {
    id: `dns_routing:${domain}`,
    name: `DNS routing — ${domain}`,
    type: 'dns_routing',
    target: domain,
    interval: 900,
    enabled: true,
    created_at: isoNow(),
  };
}

function dnsRoutingPayload(opts: { expected: string | null; resolved: string[]; matched: boolean }) {
  return `dns_routing:${JSON.stringify(opts)}`;
}

function letsdebugPayload(problems: { name?: string; explanation?: string; severity?: string }[], submissionUrl = 'https://letsdebug.net/x.example.com/1') {
  return `letsdebug:${JSON.stringify({ problems, submissionUrl })}`;
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
    makeDnsRoutingCheck('one.example.com'),
    makeDnsRoutingCheck('two.example.com'),
  ];
  state.results.clear();
  state.runOutcome = { status: 'ok', message: '' };
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
    state.results.set('dns_routing:one.example.com', {
      check_id: 'dns_routing:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    state.results.set('dns_routing:two.example.com', {
      check_id: 'dns_routing:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('ok');
    expect(r.items).toBeUndefined();
    expect(r.detail).toMatch(/2 public domains resolving to your public IP/);
  });

  it('flags a domain whose A record points at a different IP as fail', async () => {
    state.results.set('dns_routing:one.example.com', {
      check_id: 'dns_routing:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'fail',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['198.51.100.7'], matched: false }),
    });
    state.results.set('dns_routing:two.example.com', {
      check_id: 'dns_routing:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('fail');
    expect(r.items).toHaveLength(1);
    expect(r.items![0].id).toBe('one.example.com');
    expect(r.items![0].detail).toMatch(/198\.51\.100\.7/);
    expect(r.items![0].detail).toMatch(/your gateway IP is 203\.0\.113\.5/);
  });

  it('flags a domain with no public A record as fail', async () => {
    state.results.set('dns_routing:one.example.com', {
      check_id: 'dns_routing:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'fail',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: [], matched: false }),
    });
    state.results.set('dns_routing:two.example.com', {
      check_id: 'dns_routing:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('fail');
    expect(r.items).toHaveLength(1);
    expect(r.items![0].detail).toMatch(/no A record/);
  });

  it('surfaces transport errors (no payload, fail status) as info rows', async () => {
    state.results.set('dns_routing:one.example.com', {
      check_id: 'dns_routing:one.example.com',
      timestamp: isoAgo(30_000),
      status: 'fail',
      message: 'DoH lookup failed: connect ETIMEDOUT',
    });
    state.results.set('dns_routing:two.example.com', {
      check_id: 'dns_routing:two.example.com',
      timestamp: isoAgo(30_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    const r = await checkDomainExternalReachability();
    expect(r.items).toHaveLength(1);
    expect(r.items![0].status).toBe('info');
    expect(r.items![0].detail).toMatch(/DNS check could not run/);
  });

  it('#611 — flags DNS-green + HTTP-fail combo (the v4.0.x outage shape)', async () => {
    // DNS is healthy for both domains.
    state.results.set('dns_routing:one.example.com', {
      check_id: 'dns_routing:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    state.results.set('dns_routing:two.example.com', {
      check_id: 'dns_routing:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    // But the HTTPS GET surfaces a 502 for one.example.com (proxy
    // forwarding to a crash-looping upstream).
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('one.example.com')) {
        return new Response('', { status: 502 }) as Response;
      }
      return new Response('', { status: 200 }) as Response;
    }) as typeof fetch);

    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('fail');
    expect(r.items).toHaveLength(1);
    expect(r.items![0].id).toBe('one.example.com');
    expect(r.items![0].detail).toMatch(/HTTP 502/);
    expect(r.items![0].detail).toMatch(/DNS layer OK/);
  });

  it('#611 — accepts 302 → auth.<publicDomain> as a healthy redirect (forward-auth)', async () => {
    state.config.reverseProxy.publicDomain = 'example.com';
    state.results.set('dns_routing:one.example.com', {
      check_id: 'dns_routing:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    state.results.set('dns_routing:two.example.com', {
      check_id: 'dns_routing:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 302, headers: { location: 'https://auth.example.com/' } }) as Response,
    );
    const r = await checkDomainExternalReachability();
    expect(r.status).toBe('ok');
    expect(r.items).toBeUndefined(); // healthy rows are collapsed
  });

  it('appends letsdebug summary to a flagged row when one exists', async () => {
    state.results.set('dns_routing:one.example.com', {
      check_id: 'dns_routing:one.example.com',
      timestamp: isoAgo(60_000),
      status: 'fail',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['198.51.100.7'], matched: false }),
    });
    state.results.set('letsdebug:one.example.com', {
      check_id: 'letsdebug:one.example.com',
      timestamp: isoAgo(120_000),
      status: 'fail',
      message: letsdebugPayload([{ name: 'ANotWorking', explanation: 'port 80 unreachable', severity: 'fatal' }]),
    });
    state.results.set('dns_routing:two.example.com', {
      check_id: 'dns_routing:two.example.com',
      timestamp: isoAgo(60_000),
      status: 'ok',
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
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
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['203.0.113.5'], matched: true }),
    };
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
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
      message: dnsRoutingPayload({ expected: '203.0.113.5', resolved: ['198.51.100.7'], matched: false }),
    };
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now', node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/198\.51\.100\.7/);
  });

  it('reports ok:false when the matching check does not exist', async () => {
    state.checks = state.checks.filter(c => c.id !== 'dns_routing:one.example.com');
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'refresh_now', node: 'Local',
      itemId: 'one.example.com',
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No DNS routing check found/);
  });
});

describe('run_letsdebug action', () => {
  it('invokes letsdebug client and saves the result', async () => {
    state.letsdebugResult = { problems: [], submissionUrl: 'https://letsdebug.net/one.example.com/99' };
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
      actionId: 'run_letsdebug', node: 'Local',
      itemId: 'one.example.com',
    });
    expect(state.letsdebugCalls).toEqual(['one.example.com']);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/passed letsdebug/);
    const saved = state.results.get('letsdebug:one.example.com');
    expect(saved).toBeDefined();
    expect(saved!.message).toMatch(/^letsdebug:/);
  });

  it('surfaces a friendly 429 message when letsdebug rate-limits', async () => {
    state.letsdebugError = new Error('letsdebug submission HTTP 429');
    const r = await dispatchProbeAction({
      probeId: 'domain_external_reachability',
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

describe('probeHttpStatus (#611)', () => {
  // Run the helper directly via dependency injection so the test
  // doesn't have to mock globalThis.fetch.
  async function probe(
    domain: string,
    publicDomain: string | null,
    fetchImpl: typeof fetch,
  ): Promise<{ status: 'ok' | 'warn' | 'fail'; detail: string }> {
    const { probeHttpStatus } = await import('./domainExternalReachability');
    return probeHttpStatus(domain, publicDomain, fetchImpl, 1_000);
  }

  function fakeFetch(response: Response): typeof fetch {
    return (async () => response) as typeof fetch;
  }

  it('200 → ok', async () => {
    const r = await probe('x.example.com', 'example.com', fakeFetch(new Response('', { status: 200 })));
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/HTTP 200/);
  });

  it('302 → auth.<publicDomain> → ok (forward-auth)', async () => {
    const r = await probe(
      'vault.example.com',
      'example.com',
      fakeFetch(new Response('', {
        status: 302,
        headers: { location: 'https://auth.example.com/?rd=https://vault.example.com/' },
      })),
    );
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/forward-auth/);
  });

  it('302 to an unrelated host → warn', async () => {
    const r = await probe(
      'vault.example.com',
      'example.com',
      fakeFetch(new Response('', {
        status: 302,
        headers: { location: 'https://google.com/' },
      })),
    );
    expect(r.status).toBe('warn');
  });

  it('302 to a relative path → ok (Navidrome / HA / Radicale same-origin)', async () => {
    // music.dopp.cloud → /web/ (Navidrome), home.dopp.cloud → /onboarding.html (HA),
    // caldav.dopp.cloud → /.web (Radicale). All are healthy "go to my UI" redirects.
    for (const path of ['/web/', '/onboarding.html', '/.web']) {
      const r = await probe(
        'music.example.com',
        'example.com',
        fakeFetch(new Response('', { status: 302, headers: { location: path } })),
      );
      expect(r.status).toBe('ok');
      expect(r.detail).toMatch(/same-origin/);
    }
  });

  it('302 to an absolute same-host URL → ok', async () => {
    const r = await probe(
      'music.example.com',
      'example.com',
      fakeFetch(new Response('', {
        status: 302,
        headers: { location: 'https://music.example.com/web/' },
      })),
    );
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/same-origin/);
  });

  it('401 → ok (auth-gated)', async () => {
    const r = await probe('x.example.com', 'example.com', fakeFetch(new Response('', { status: 401 })));
    expect(r.status).toBe('ok');
    expect(r.detail).toMatch(/auth-gated/);
  });

  it('502 → fail with status code', async () => {
    const r = await probe('x.example.com', 'example.com', fakeFetch(new Response('', { status: 502 })));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/HTTP 502/);
  });

  it('500 → fail', async () => {
    const r = await probe('x.example.com', 'example.com', fakeFetch(new Response('', { status: 500 })));
    expect(r.status).toBe('fail');
  });

  it('404 (other 4xx) → warn — many apps don\'t serve /', async () => {
    const r = await probe('x.example.com', 'example.com', fakeFetch(new Response('', { status: 404 })));
    expect(r.status).toBe('warn');
  });

  it('network error → fail with the message', async () => {
    const failingFetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    const r = await probe('x.example.com', 'example.com', failingFetch);
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });

  it('no public-domain suffix → 302 to anything is warn (can\'t recognise auth host)', async () => {
    const r = await probe(
      'vault.home.arpa',
      null,
      fakeFetch(new Response('', {
        status: 302,
        headers: { location: 'https://auth.home.arpa/' },
      })),
    );
    // Without a configured publicDomain we can't tell forward-auth from
    // any other redirect.
    expect(r.status).toBe('warn');
  });
});
