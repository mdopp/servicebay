import { describe, it, expect } from 'vitest';
import { deriveCardStatus } from './services';

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
