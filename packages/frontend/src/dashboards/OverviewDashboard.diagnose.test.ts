/**
 * Home Overview Diagnose card breakdown (#1873).
 *
 * The Diagnose OverviewCard surfaces the LATEST PERSISTED diagnose run from
 * GET /api/health/checks (same endpoint HealthDashboard polls) — no diagnose
 * run is triggered on render. These tests cover the two pure helpers that
 * derive the card's counts + tone from the enriched check rows:
 *  - summarizeDiagnoseRows: filter to `diagnose:*` rows, bucket by the
 *    four-way diagnose.status (ok→healthy, warn→warning, fail→failure,
 *    info/none→unknown).
 *  - diagnoseCardView: metric/description/tone with worst-status tone.
 */
import { describe, it, expect } from 'vitest';
import { summarizeDiagnoseRows, diagnoseCardView } from './OverviewDashboard';

describe('summarizeDiagnoseRows', () => {
  it('buckets the four-way diagnose.status and ignores non-diagnose rows', () => {
    const rows = [
      { id: 'diagnose:agent', diagnose: { status: 'ok' } },
      { id: 'diagnose:dns', diagnose: { status: 'warn' } },
      { id: 'diagnose:cert', diagnose: { status: 'fail' } },
      { id: 'diagnose:sso', diagnose: { status: 'info' } },
      { id: 'diagnose:legacy', diagnose: { status: undefined } },
      // Non-diagnose check rows must not be counted.
      { id: 'http-portal', status: 'ok' },
      { id: 'ping-router', status: 'fail' },
    ];
    expect(summarizeDiagnoseRows(rows)).toEqual({
      healthy: 1,
      warning: 1,
      failure: 1,
      unknown: 2, // info + missing-status
      total: 5,
    });
  });

  it('falls back to the row status when diagnose field is absent', () => {
    const rows = [
      { id: 'diagnose:a', status: 'ok' },
      { id: 'diagnose:b', status: 'fail' },
    ];
    expect(summarizeDiagnoseRows(rows)).toEqual({
      healthy: 1,
      warning: 0,
      failure: 1,
      unknown: 0,
      total: 2,
    });
  });

  it('returns all-zero for zero diagnose rows (never run)', () => {
    expect(summarizeDiagnoseRows([{ id: 'http-x', status: 'ok' }])).toEqual({
      healthy: 0,
      warning: 0,
      failure: 0,
      unknown: 0,
      total: 0,
    });
  });
});

describe('diagnoseCardView', () => {
  const base = { healthy: 0, warning: 0, failure: 0, unknown: 0, total: 0, loaded: true };

  it('is neutral "Reading…" while not loaded', () => {
    const v = diagnoseCardView({ ...base, loaded: false });
    expect(v.tone).toBe('neutral');
  });

  it('renders "Not run yet" / neutral when no persisted results', () => {
    const v = diagnoseCardView({ ...base, total: 0 });
    expect(v.metric).toBe('Not run yet');
    expect(v.tone).toBe('neutral');
  });

  it('tone is bad when any failure present', () => {
    const v = diagnoseCardView({ ...base, healthy: 3, warning: 1, failure: 2, total: 6 });
    expect(v.tone).toBe('bad');
    expect(v.metric).toBe('3 healthy · 1 warning · 2 failure');
  });

  it('tone is warn when warnings but no failures', () => {
    const v = diagnoseCardView({ ...base, healthy: 4, warning: 1, failure: 0, total: 5 });
    expect(v.tone).toBe('warn');
  });

  it('tone is good when run with no warnings or failures', () => {
    const v = diagnoseCardView({ ...base, healthy: 5, total: 5 });
    expect(v.tone).toBe('good');
    expect(v.description).toBe('All probes healthy');
  });
});
