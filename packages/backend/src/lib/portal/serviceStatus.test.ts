import { describe, it, expect, vi, beforeEach } from 'vitest';

const getLastResult = vi.fn();
vi.mock('@/lib/health/store', () => ({
  HealthStore: { getLastResult: (id: string) => getLastResult(id) },
}));

import { deriveCardStatus, hostFromUrl, resolveCardStatus } from './services';

describe('deriveCardStatus (#1654)', () => {
  it('is unknown when there is no signal', () => {
    expect(deriveCardStatus({})).toEqual({ status: 'unknown' });
    // pod active but no health/domain signal yet → still unknown
    expect(deriveCardStatus({ podActive: true })).toEqual({ status: 'unknown' });
  });

  it('is down when the pod is explicitly inactive', () => {
    const r = deriveCardStatus({ podActive: false, twinReady: true, domainOk: true });
    expect(r.status).toBe('down');
    expect(r.statusReason).toBe('Not running');
  });

  it('is down when the domain reachability check is failing', () => {
    const r = deriveCardStatus({ podActive: true, domainOk: false });
    expect(r.status).toBe('down');
    expect(r.statusReason).toBe('Not reachable');
  });

  it('is down when the only health signal is failing', () => {
    const r = deriveCardStatus({ podActive: true, twinReady: false });
    expect(r.status).toBe('down');
    expect(r.statusReason).toBe('Health check failing');
  });

  it('is down when every present hard signal fails', () => {
    const r = deriveCardStatus({ twinReady: false, domainOk: false });
    expect(r.status).toBe('down');
    // domain failure wins the reason
    expect(r.statusReason).toBe('Not reachable');
  });

  it('is degraded when signals disagree (some healthy, some failing)', () => {
    const r = deriveCardStatus({ twinReady: true, domainOk: false });
    expect(r.status).toBe('degraded');
    expect(r.statusReason).toBe('Partially unhealthy');
  });

  it('is degraded when the service reports a soft-fail', () => {
    const r = deriveCardStatus({ twinReady: true, twinDegraded: true, domainOk: true });
    expect(r.status).toBe('degraded');
    expect(r.statusReason).toBe('Running in a degraded state');
  });

  it('is ok when every present signal is healthy', () => {
    expect(deriveCardStatus({ twinReady: true, domainOk: true })).toEqual({ status: 'ok' });
    expect(deriveCardStatus({ domainOk: true })).toEqual({ status: 'ok' });
    expect(deriveCardStatus({ twinReady: true })).toEqual({ status: 'ok' });
  });
});

describe('hostFromUrl (#1654)', () => {
  it('extracts the hostname from a valid URL', () => {
    expect(hostFromUrl('https://photos.home.arpa/login')).toBe('photos.home.arpa');
    expect(hostFromUrl('http://192.168.1.10:8080')).toBe('192.168.1.10');
  });

  it('returns null for null or unparseable input', () => {
    expect(hostFromUrl(null)).toBeNull();
    expect(hostFromUrl('not a url')).toBeNull();
  });
});

describe('resolveCardStatus (#1654) — signal gathering', () => {
  beforeEach(() => {
    getLastResult.mockReset();
    getLastResult.mockReturnValue(null);
  });

  const twinMap = (
    entries: Record<string, { ready: boolean; degraded?: boolean }>,
  ) => new Map(Object.entries(entries));

  it('is down when the pod is inactive regardless of other signals', () => {
    getLastResult.mockReturnValue({ status: 'ok' });
    const r = resolveCardStatus(false, 'immich', 'https://photos.home.arpa', twinMap({ immich: { ready: true } }));
    expect(r.status).toBe('down');
    expect(r.statusReason).toBe('Not running');
  });

  it('reads the twin readiness + domain check by host key', () => {
    getLastResult.mockReturnValue({ status: 'ok' });
    const r = resolveCardStatus(true, 'immich', 'https://photos.home.arpa', twinMap({ immich: { ready: true } }));
    expect(getLastResult).toHaveBeenCalledWith('domain:photos.home.arpa');
    expect(r.status).toBe('ok');
  });

  it('is down when the domain reachability check is failing', () => {
    getLastResult.mockReturnValue({ status: 'fail' });
    const r = resolveCardStatus(true, 'immich', 'https://photos.home.arpa', twinMap({ immich: { ready: true } }));
    expect(r.status).toBe('degraded'); // twin ok + domain fail → disagree
    expect(r.statusReason).toBe('Partially unhealthy');
  });

  it('surfaces the twin soft-fail (degraded) flag', () => {
    getLastResult.mockReturnValue({ status: 'ok' });
    const r = resolveCardStatus(true, 'immich', 'https://photos.home.arpa', twinMap({ immich: { ready: true, degraded: true } }));
    expect(r.status).toBe('degraded');
    expect(r.statusReason).toBe('Running in a degraded state');
  });

  it('does not query the HealthStore when there is no URL', () => {
    const r = resolveCardStatus(true, 'immich', null, twinMap({ immich: { ready: true } }));
    expect(getLastResult).not.toHaveBeenCalled();
    expect(r.status).toBe('ok'); // twin-only signal
  });

  it('is unknown when no twin entry and no domain result exist', () => {
    const r = resolveCardStatus(true, 'immich', 'https://photos.home.arpa', twinMap({}));
    expect(r.status).toBe('unknown');
  });
});
