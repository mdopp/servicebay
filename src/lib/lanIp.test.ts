import { describe, it, expect } from 'vitest';
import { recentChanges, dateNDaysAgo } from './lanIp';

const today = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString();
};

describe('recentChanges', () => {
  it('returns 0 for an empty history', () => {
    expect(recentChanges([], 30)).toBe(0);
  });

  it('returns 0 for a single distinct IP within window', () => {
    expect(recentChanges([{ ip: '10.0.0.5', detectedAt: today(1) }], 30)).toBe(0);
  });

  it('counts distinct-IP transitions within the window only', () => {
    const history = [
      { ip: '10.0.0.5', detectedAt: today(2) },
      { ip: '10.0.0.6', detectedAt: today(1) },
      { ip: '10.0.0.5', detectedAt: today(0) },
    ];
    // Distinct IPs in window = 2; changes = 1
    expect(recentChanges(history, 30)).toBe(1);
  });

  it('ignores entries older than the window', () => {
    const history = [
      { ip: '10.0.0.4', detectedAt: today(60) }, // outside window
      { ip: '10.0.0.5', detectedAt: today(20) },
      { ip: '10.0.0.6', detectedAt: today(5) },
      { ip: '10.0.0.7', detectedAt: today(1) },
    ];
    // Within 30 days: 3 distinct → 2 changes
    expect(recentChanges(history, 30)).toBe(2);
  });
});

describe('dateNDaysAgo', () => {
  it('returns a Date in the past', () => {
    const d = dateNDaysAgo(7);
    expect(d.getTime()).toBeLessThan(Date.now());
    expect(Date.now() - d.getTime()).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
  });
});
