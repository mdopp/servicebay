import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/config', () => ({ getConfig: vi.fn() }));
vi.mock('@/lib/health/store', () => ({
  HealthStore: { getChecks: vi.fn(), getLastResult: vi.fn() },
}));
vi.mock('@/lib/letsdebug/client', () => ({ runLetsdebugForDomain: vi.fn() }));

import { getConfig } from '@/lib/config';
import { HealthStore } from '@/lib/health/store';
import { getPreflightStatus } from '@/lib/reverseProxy/preflight';

beforeEach(() => {
  vi.mocked(getConfig).mockResolvedValue({
    autoUpdate: { enabled: false, schedule: '' },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  vi.mocked(HealthStore.getChecks).mockReturnValue([]);
  vi.mocked(HealthStore.getLastResult).mockReturnValue(null);
});

const okLetsdebug = vi.fn(async () => ({ problems: [], submissionUrl: 'https://letsdebug.net/dopp.cloud/1' }));
const dnsFailLetsdebug = vi.fn(async () => ({
  problems: [{ name: 'NoIPAddress', severity: 'Fatal', explanation: 'A record missing' }],
  submissionUrl: 'https://letsdebug.net/x/2',
}));
const http01FailLetsdebug = vi.fn(async () => ({
  problems: [{ name: 'PortNotOpen', severity: 'Fatal', explanation: 'port 80 closed' }],
  submissionUrl: 'https://letsdebug.net/x/3',
}));

describe('getPreflightStatus', () => {
  it('reports ready when letsdebug returns no problems and port-forward is unknown without gateway', async () => {
    const r = await getPreflightStatus('dopp.cloud', {
      runLetsdebug: okLetsdebug,
      getFritzboxLastResult: async () => null,
    });
    expect(r.ready).toBe(true);
    expect(r.checks.map(c => c.status)).toEqual(['pass', 'pass', 'unknown']);
  });

  it('reports not-ready when DNS is fatal', async () => {
    const r = await getPreflightStatus('dopp.cloud', {
      runLetsdebug: dnsFailLetsdebug,
      getFritzboxLastResult: async () => null,
    });
    expect(r.ready).toBe(false);
    expect(r.checks[0].status).toBe('fail');
    expect(r.checks[0].detail).toMatch(/NoIPAddress/);
  });

  it('reports not-ready when HTTP-01 is fatal', async () => {
    const r = await getPreflightStatus('dopp.cloud', {
      runLetsdebug: http01FailLetsdebug,
      getFritzboxLastResult: async () => null,
    });
    expect(r.ready).toBe(false);
    expect(r.checks[1].status).toBe('fail');
    expect(r.checks[1].detail).toMatch(/PortNotOpen/);
  });

  it('reports not-ready when fritzbox returns a fail result', async () => {
    const r = await getPreflightStatus('dopp.cloud', {
      runLetsdebug: okLetsdebug,
      getFritzboxLastResult: async () => ({ status: 'fail', message: 'no port-forward for 443' }),
    });
    expect(r.ready).toBe(false);
    expect(r.checks[2].status).toBe('fail');
    expect(r.checks[2].detail).toMatch(/443/);
  });

  it('treats a letsdebug exception as not-ready without crashing', async () => {
    const r = await getPreflightStatus('dopp.cloud', {
      runLetsdebug: vi.fn(async () => { throw new Error('rate-limited'); }),
      getFritzboxLastResult: async () => null,
    });
    expect(r.ready).toBe(false);
    expect(r.checks[0].detail).toMatch(/rate-limited/);
  });
});
