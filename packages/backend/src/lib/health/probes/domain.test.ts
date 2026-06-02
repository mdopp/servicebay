import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckConfig } from '../types';

const state = {
  lanIp: '192.168.1.10' as string | undefined,
  publicIp: '203.0.113.5' as string,
};

vi.mock('../../config', () => ({
  getConfig: () => Promise.resolve({ reverseProxy: { lanIp: state.lanIp } }),
}));

// resolveDnsRouting imports getGateway lazily from store/repository.
vi.mock('../../store/repository', () => ({
  getGateway: () => ({ publicIp: state.publicIp }),
}));

import { getProbe } from './registry';
// Side-effect: registers the `domain` probe.
import './domain';

const probe = () => {
  const p = getProbe('domain');
  if (!p) throw new Error('domain probe not registered');
  return p;
};

const ctx = { executor: {} as never };

function makeCheck(domain: string, isPublic: boolean): CheckConfig {
  return {
    id: `domain:${domain}`,
    name: `Domain — ${domain}`,
    type: 'domain',
    target: domain,
    interval: 60,
    enabled: true,
    created_at: new Date().toISOString(),
    domainConfig: { expectedScheme: isPublic ? 'https' : 'http', isPublic },
  };
}

/** First fetch call = NPM routing (http://lanIp:80/); subsequent = DoH. */
function mockFetch(npm: Response, doh?: Response) {
  let n = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation((async () => {
    n += 1;
    return n === 1 ? npm : (doh ?? new Response('', { status: 200 }));
  }) as typeof fetch);
}

function dohAnswer(ips: string[]): Response {
  return new Response(
    JSON.stringify({ Answer: ips.map(ip => ({ type: 1, data: ip })) }),
    { status: 200, headers: { 'content-type': 'application/dns-json' } },
  );
}

describe('domain probe (#1564 — merged NPM routing + DNS routing)', () => {
  beforeEach(() => {
    state.lanIp = '192.168.1.10';
    state.publicIp = '203.0.113.5';
    vi.restoreAllMocks();
  });

  it('LAN domain: runs NPM routing only, no DNS payload', async () => {
    mockFetch(new Response('', { status: 200 }));
    const res = await probe().run(makeCheck('home.arpa.lan', false), ctx) as { status: string; payload?: unknown };
    expect(res.status).toBe('ok');
    expect(res.payload).toBeUndefined();
  });

  it('public domain: NPM ok + DNS matches gateway → ok with payload', async () => {
    mockFetch(new Response('', { status: 200 }), dohAnswer(['203.0.113.5']));
    const res = await probe().run(makeCheck('one.example.com', true), ctx) as {
      status: string; payload?: { matched: boolean; expected: string | null };
    };
    expect(res.status).toBe('ok');
    expect(res.payload?.matched).toBe(true);
    expect(res.payload?.expected).toBe('203.0.113.5');
  });

  it('public domain: NPM ok but DNS points elsewhere → fail with payload', async () => {
    mockFetch(new Response('', { status: 200 }), dohAnswer(['198.51.100.7']));
    const res = await probe().run(makeCheck('one.example.com', true), ctx) as {
      status: string; payload?: { matched: boolean; resolved: string[] };
    };
    expect(res.status).toBe('fail');
    expect(res.payload?.matched).toBe(false);
    expect(res.payload?.resolved).toEqual(['198.51.100.7']);
  });

  it('public domain: NPM "not configured" → throws (CheckRunner reports fail)', async () => {
    mockFetch(new Response('<h1>Congratulations</h1>', { status: 404 }));
    await expect(probe().run(makeCheck('ghost.example.com', true), ctx)).rejects.toThrow(/not configured/);
  });

  it('throws when reverseProxy.lanIp is missing', async () => {
    state.lanIp = undefined;
    await expect(probe().run(makeCheck('one.example.com', true), ctx)).rejects.toThrow(/lanIp not configured/);
  });
});
