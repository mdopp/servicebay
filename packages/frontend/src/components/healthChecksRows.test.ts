/**
 * #1671 — synthetic diagnose check rows must surface the same history + a
 * non-misleading last-checked as every other row. These cover the pure row
 * helpers: a diagnose row is recognised (so it gets the History drawer like
 * any other check), and its last-checked is qualified with the daily cadence
 * so a ~20h-old self-diagnose timestamp doesn't read as "stale".
 */
import { describe, it, expect } from 'vitest';
import type { Check } from '@servicebay/api-client';
import { isDiagnoseRow, lastCheckedLabel } from './HealthChecks';

function makeCheck(over: Partial<Check>): Check {
  return {
    id: 'c1',
    name: 'Check',
    type: 'http',
    target: 'http://example.com',
    interval: 60,
    enabled: true,
    created_at: new Date(0).toISOString(),
    status: 'ok',
    lastRun: null,
    lastResult: null,
    history: [],
    ...over,
  } as Check;
}

describe('isDiagnoseRow', () => {
  it('is true when the row carries a diagnose payload', () => {
    const row = makeCheck({ id: 'diagnose:agent', diagnose: { status: 'ok' } } as Partial<Check>);
    expect(isDiagnoseRow(row)).toBe(true);
  });

  it('is false for a regular check', () => {
    expect(isDiagnoseRow(makeCheck({}))).toBe(false);
  });
});

describe('lastCheckedLabel', () => {
  it('returns Never when the row has not run', () => {
    expect(lastCheckedLabel(makeCheck({ lastRun: null }))).toBe('Never');
  });

  it('shows a plain timestamp for a normal check', () => {
    const ts = '2026-06-05T10:00:00.000Z';
    const label = lastCheckedLabel(makeCheck({ lastRun: ts }));
    expect(label).toBe(new Date(ts).toLocaleString());
    expect(label).not.toContain('self-diagnose');
  });

  it('qualifies a diagnose row timestamp with the daily cadence', () => {
    const ts = '2026-06-04T14:00:00.000Z';
    const label = lastCheckedLabel(
      makeCheck({ id: 'diagnose:agent', lastRun: ts, diagnose: { status: 'ok' } } as Partial<Check>),
    );
    expect(label).toContain(new Date(ts).toLocaleString());
    expect(label).toContain('daily self-diagnose');
  });
});
