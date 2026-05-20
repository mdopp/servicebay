/**
 * `ServiceHealthPoller` probe contract — #626.
 *
 * Drives the probe path directly (no timers, no twin side effects in
 * these cases — we test `probe()` for purity and `tick()` for the twin
 * write). The twin is mocked so we don't have to register a node first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const setServiceHealthMock = vi.fn();
const clearServiceHealthMock = vi.fn();

vi.mock('@/lib/store/twin', () => ({
  DigitalTwinStore: {
    getInstance: () => ({
      setServiceHealth: setServiceHealthMock,
      clearServiceHealth: clearServiceHealthMock,
    }),
  },
}));

import { ServiceHealthPoller } from './serviceHealth';
import type { HealthcheckConfig } from './serviceHealthcheck';

const fetchSpy = vi.spyOn(globalThis, 'fetch');

beforeEach(() => {
  setServiceHealthMock.mockClear();
  clearServiceHealthMock.mockClear();
  fetchSpy.mockReset();
});

afterEach(() => {
  fetchSpy.mockReset();
});

function http(url: string, intervalMs = 30_000, timeoutMs = 5_000): HealthcheckConfig {
  return { kind: 'http', url, intervalMs, timeoutMs, startupTimeoutMs: 300_000 };
}

function makeResponse(status: number, body: unknown, json = true): Response {
  return new Response(json ? JSON.stringify(body) : String(body), {
    status,
    headers: { 'content-type': json ? 'application/json' : 'text/plain' },
  });
}

describe('ServiceHealthPoller.probe — HTTP', () => {
  it('returns ready on 200 with `{ ready: true }`', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, { ready: true }));
    const poller = new ServiceHealthPoller();
    const h = await poller.probe({ nodeName: 'Local', serviceName: 'nginx', config: http('http://x/health') });
    expect(h.ready).toBe(true);
    expect(h.message).toBeUndefined();
  });

  it('treats 2xx without a `ready` field as ready (empty body)', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, {}, true));
    const poller = new ServiceHealthPoller();
    const h = await poller.probe({ nodeName: 'Local', serviceName: 'x', config: http('http://x/h') });
    expect(h.ready).toBe(true);
  });

  it('treats non-JSON 200 as ready (plain "ok" body)', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, 'ok', false));
    const poller = new ServiceHealthPoller();
    const h = await poller.probe({ nodeName: 'Local', serviceName: 'x', config: http('http://x/h') });
    expect(h.ready).toBe(true);
  });

  it('returns ready: false on non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(503, 'down', false));
    const poller = new ServiceHealthPoller();
    const h = await poller.probe({ nodeName: 'Local', serviceName: 'x', config: http('http://x/h') });
    expect(h.ready).toBe(false);
    expect(h.message).toBe('HTTP 503');
  });

  it('surfaces network errors as ready: false with the message', async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError('connect ECONNREFUSED'));
    const poller = new ServiceHealthPoller();
    const h = await poller.probe({ nodeName: 'Local', serviceName: 'x', config: http('http://x/h') });
    expect(h.ready).toBe(false);
    expect(h.message).toMatch(/ECONNREFUSED/);
  });

  it('passes through `degraded` + `message` + `deps`', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, {
      ready: true,
      degraded: true,
      message: 'using fallback DNS',
      deps: { lldap: 'ok', smtp: 'unreachable' },
    }));
    const poller = new ServiceHealthPoller();
    const h = await poller.probe({ nodeName: 'Local', serviceName: 'authelia', config: http('http://x/h') });
    expect(h.ready).toBe(true);
    expect(h.degraded).toBe(true);
    expect(h.message).toBe('using fallback DNS');
    expect(h.deps).toEqual({ lldap: 'ok', smtp: 'unreachable' });
  });

  it('drops unknown dep status values rather than passing garbage through', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, {
      ready: true,
      deps: { good: 'ok', bad: 'pancakes' },
    }));
    const poller = new ServiceHealthPoller();
    const h = await poller.probe({ nodeName: 'Local', serviceName: 'x', config: http('http://x/h') });
    expect(h.deps).toEqual({ good: 'ok' });
  });

  it('truncates oversized `message` so a chatty service can\'t bloat the twin', async () => {
    const huge = 'x'.repeat(2000);
    fetchSpy.mockResolvedValueOnce(makeResponse(200, { ready: false, message: huge }));
    const poller = new ServiceHealthPoller();
    const h = await poller.probe({ nodeName: 'Local', serviceName: 'x', config: http('http://x/h') });
    expect(h.message!.length).toBeLessThanOrEqual(512);
  });
});

describe('ServiceHealthPoller.tick — writes through to twin', () => {
  it('writes the probe result via setServiceHealth on success', async () => {
    fetchSpy.mockResolvedValueOnce(makeResponse(200, { ready: true }));
    const poller = new ServiceHealthPoller();
    poller.register({ nodeName: 'Local', serviceName: 'nginx', config: http('http://x/h') });
    await poller.tick('Local::nginx');
    expect(setServiceHealthMock).toHaveBeenCalledOnce();
    const [node, name, health] = setServiceHealthMock.mock.calls[0];
    expect(node).toBe('Local');
    expect(name).toBe('nginx');
    expect(health.ready).toBe(true);
    expect(health.lastCheckedAt).toMatch(/^\d{4}-/);
  });

  it('writes a ready:false health on probe failure (no exception)', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('boom'));
    const poller = new ServiceHealthPoller();
    poller.register({ nodeName: 'Local', serviceName: 'nginx', config: http('http://x/h') });
    await poller.tick('Local::nginx');
    expect(setServiceHealthMock).toHaveBeenCalledOnce();
    expect(setServiceHealthMock.mock.calls[0][2].ready).toBe(false);
  });

  it('ignores ticks for unknown registrations', async () => {
    const poller = new ServiceHealthPoller();
    await poller.tick('Local::ghost');
    expect(setServiceHealthMock).not.toHaveBeenCalled();
  });
});

describe('ServiceHealthPoller registry mutation', () => {
  it('register replaces an existing entry by (node, name) key', () => {
    const poller = new ServiceHealthPoller();
    poller.register({ nodeName: 'Local', serviceName: 'x', config: http('http://a') });
    poller.register({ nodeName: 'Local', serviceName: 'x', config: http('http://b') });
    expect(poller.list()).toHaveLength(1);
    expect(poller.list()[0].config.url).toBe('http://b');
  });

  it('unregister clears the entry AND clears twin state', () => {
    const poller = new ServiceHealthPoller();
    poller.register({ nodeName: 'Local', serviceName: 'x', config: http('http://a') });
    poller.unregister('Local', 'x');
    expect(poller.list()).toHaveLength(0);
    expect(clearServiceHealthMock).toHaveBeenCalledWith('Local', 'x');
  });
});
