import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * #2654/#2655 (from #2651) — the read tool and the write tools must resolve an
 * id against the same sources. These tests pin the DERIVATION: the diagnose arm
 * asks the diagnose reader for its rows, so it covers the whole probe class
 * without a probe-id list anywhere.
 */

const stored = vi.hoisted(() => ({ checks: [] as unknown[], diagnose: [] as unknown[] }));
const diagnoseReader = vi.hoisted(() => ({ calls: 0 }));

vi.mock('./store', () => ({
  HealthStore: { getChecks: () => stored.checks },
}));
vi.mock('@/lib/diagnose/diagnoseChecks', () => ({
  DIAGNOSE_CHECK_ID_PREFIX: 'diagnose:',
  isDiagnoseCheckId: (id: string) => id.startsWith('diagnose:'),
  getDiagnoseChecksEnriched: () => { diagnoseReader.calls += 1; return stored.diagnose; },
}));

import { resolveCheckId, checkNotFoundMessage } from './checkLookup';

beforeEach(() => {
  diagnoseReader.calls = 0;
  stored.checks = [{ id: 'domain:admin.dopp.cloud', type: 'domain', target: 'admin.dopp.cloud' }];
  stored.diagnose = [
    { id: 'diagnose:sso_verify' },
    { id: 'diagnose:content_backup' },
    { id: 'diagnose:raid' },
  ];
});

describe('resolveCheckId (#2654/#2655)', () => {
  it('resolves a stored check, carrying the config the runner needs', () => {
    const r = resolveCheckId('domain:admin.dopp.cloud');
    expect(r.kind).toBe('stored');
    if (r.kind !== 'stored') throw new Error('unreachable');
    expect(r.check.target).toBe('admin.dopp.cloud');
  });

  it('resolves EVERY diagnose row the reader lists, not one named probe', () => {
    // The #1709 fix only ever covered sso_verify. The class is what matters:
    // whatever the reader returned resolves, including a probe nobody wrote a
    // branch for.
    stored.diagnose = [...(stored.diagnose as { id: string }[]), { id: 'diagnose:a_probe_added_tomorrow' }];
    for (const row of stored.diagnose as { id: string }[]) {
      const r = resolveCheckId(row.id);
      expect(r.kind).toBe('diagnose');
      if (r.kind !== 'diagnose') throw new Error('unreachable');
      expect(r.probeId).toBe(row.id.slice('diagnose:'.length));
    }
  });

  it('derives the diagnose class from the reader — a prefix alone does not resolve', () => {
    // A probe with no persisted result is NOT listed by get_health_checks, so
    // it must not resolve either: listed and resolvable are one predicate.
    expect(resolveCheckId('diagnose:never_ran').kind).toBe('unknown');
    expect(diagnoseReader.calls).toBeGreaterThan(0);
  });

  it('reports unknown for an id no reader lists', () => {
    expect(resolveCheckId('domain:gone.dopp.cloud').kind).toBe('unknown');
    expect(resolveCheckId('totally-made-up').kind).toBe('unknown');
  });

  it('does not pay for the diagnose read on a plain miss', () => {
    resolveCheckId('totally-made-up');
    expect(diagnoseReader.calls).toBe(0);
  });

  it('a stored check wins over the diagnose projection for the same id', () => {
    stored.checks = [{ id: 'diagnose:sso_verify', type: 'http', target: 'http://x' }];
    expect(resolveCheckId('diagnose:sso_verify').kind).toBe('stored');
  });

  it('the not-found message points the caller at the tool that lists both sources', () => {
    expect(checkNotFoundMessage('nope')).toContain('get_health_checks');
    expect(checkNotFoundMessage('nope')).toContain('diagnose:');
  });
});
