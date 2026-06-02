import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckResult } from '@/lib/health/types';

const store = { results: new Map<string, CheckResult[]>() };

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    saveResult: (r: CheckResult) => {
      const arr = store.results.get(r.check_id) ?? [];
      arr.unshift(r);
      store.results.set(r.check_id, arr);
    },
    getResults: (id: string) => store.results.get(id) ?? [],
    getLastResult: (id: string) => store.results.get(id)?.[0] ?? null,
  },
}));

import {
  diagnoseCheckId,
  isDiagnoseCheckId,
  diagnoseStatusToCheckStatus,
  diagnoseProbeToPayload,
  persistDiagnoseResults,
  buildProbeHistory,
  encodeDiagnoseMessage,
  decodeDiagnoseMessage,
  type PersistableProbe,
} from './persistDiagnoseResults';

const probe = (over: Partial<PersistableProbe>): PersistableProbe => ({
  id: 'agent',
  label: 'Agent reachable',
  status: 'ok',
  detail: 'fine',
  ...over,
});

beforeEach(() => store.results.clear());

describe('check ids', () => {
  it('prefixes + recognises', () => {
    expect(diagnoseCheckId('pods')).toBe('diagnose:pods');
    expect(isDiagnoseCheckId('diagnose:pods')).toBe(true);
    expect(isDiagnoseCheckId('some-uuid')).toBe(false);
  });
});

describe('diagnoseStatusToCheckStatus', () => {
  it('warn/fail -> fail, ok/info -> ok', () => {
    expect(diagnoseStatusToCheckStatus('ok')).toBe('ok');
    expect(diagnoseStatusToCheckStatus('info')).toBe('ok');
    expect(diagnoseStatusToCheckStatus('warn')).toBe('fail');
    expect(diagnoseStatusToCheckStatus('fail')).toBe('fail');
  });
});

describe('diagnoseProbeToPayload', () => {
  it('carries the typed four-way status, detail, hint and items (#1539 shape)', () => {
    const p = probe({
      status: 'warn',
      detail: 'one down',
      hint: 'restart it',
      // Resolved item shape (full `actions` objects) as it appears on a
      // DiagnoseProbe at persist time — normalised back to `actionIds`.
      items: [{ id: 'x', label: 'x', detail: 'd', status: 'warn', actions: [{ id: 'restart_pod' }] }],
    });
    const payload = diagnoseProbeToPayload(p);
    expect(payload).toEqual({
      status: 'warn',
      detail: 'one down',
      hint: 'restart it',
      items: [{ id: 'x', label: 'x', detail: 'd', status: 'warn', actionIds: ['restart_pod'] }],
    });
  });
});

describe('encode/decode message (legacy bridge, retained)', () => {
  it('round-trips status + payload', () => {
    const p = probe({ status: 'warn', detail: 'd', hint: 'h', actions: [{ id: 'a' }] });
    const decoded = decodeDiagnoseMessage(encodeDiagnoseMessage(p));
    expect(decoded?.status).toBe('warn');
    expect(decoded?.detail).toBe('d');
    expect(decoded?.hint).toBe('h');
  });

  it('null for non-diagnose / corrupt', () => {
    expect(decodeDiagnoseMessage('plain')).toBeNull();
    expect(decodeDiagnoseMessage(null)).toBeNull();
    expect(decodeDiagnoseMessage('diagnose:{not json')).toBeNull();
  });
});

describe('persistDiagnoseResults', () => {
  it('side-writes one result per probe with the typed payload + binary status', () => {
    const results = persistDiagnoseResults([
      probe({ id: 'agent', status: 'ok', detail: 'ok' }),
      probe({ id: 'pods', status: 'warn', detail: 'one down' }),
      probe({ id: 'serial', status: 'info', detail: 'none' }),
    ]);

    expect(results.map(r => r.check_id)).toEqual(['diagnose:agent', 'diagnose:pods', 'diagnose:serial']);
    expect(results.map(r => r.status)).toEqual(['ok', 'fail', 'ok']); // warn->fail, info->ok

    // Persisted to the store, one entry per probe.
    expect(store.results.get('diagnose:pods')).toHaveLength(1);
    const persisted = store.results.get('diagnose:pods')![0];
    // Typed payload (#1539) carries the four-way nuance the binary status loses.
    expect(persisted.payload).toEqual({ status: 'warn', detail: 'one down', hint: undefined, items: undefined });
    // Legacy encoded message still attached for the #1423 popup reader.
    expect(decodeDiagnoseMessage(persisted.message)?.status).toBe('warn');
  });

  it('accrues history across runs (the point of #1540)', () => {
    persistDiagnoseResults([probe({ id: 'disk', status: 'ok' })]);
    persistDiagnoseResults([probe({ id: 'disk', status: 'warn' })]);
    expect(store.results.get('diagnose:disk')).toHaveLength(2);
    // Newest first.
    expect(store.results.get('diagnose:disk')![0].status).toBe('fail');
  });
});

describe('buildProbeHistory (#1541)', () => {
  // Helper: push a result with an explicit timestamp, newest-first (store order).
  const seed = (id: string, entries: { status: 'ok' | 'fail'; ts: string }[]) => {
    // entries given newest-first to mirror the store layout.
    store.results.set(
      diagnoseCheckId(id),
      entries.map(e => ({ check_id: diagnoseCheckId(id), timestamp: e.ts, status: e.status })),
    );
  };

  it('returns null when the probe has no persisted results', () => {
    expect(buildProbeHistory('never-run')).toBeNull();
  });

  it('summarises first-seen, last-ok and an oldest→newest trend', () => {
    seed('disk', [
      { status: 'fail', ts: '2026-06-02T12:00:00Z' }, // newest
      { status: 'ok', ts: '2026-06-02T11:00:00Z' },
      { status: 'ok', ts: '2026-06-01T10:00:00Z' }, // oldest
    ]);
    const h = buildProbeHistory('disk')!;
    expect(h.firstSeen).toBe('2026-06-01T10:00:00Z'); // oldest retained
    expect(h.lastOk).toBe('2026-06-02T11:00:00Z'); // most recent ok
    expect(h.trend).toEqual(['ok', 'ok', 'fail']); // oldest → newest
    expect(h.total).toBe(3);
  });

  it('reports lastOk:null when every retained result is failing', () => {
    seed('pods', [
      { status: 'fail', ts: '2026-06-02T12:00:00Z' },
      { status: 'fail', ts: '2026-06-02T11:00:00Z' },
    ]);
    const h = buildProbeHistory('pods')!;
    expect(h.lastOk).toBeNull();
    expect(h.trend).toEqual(['fail', 'fail']);
  });

  it('caps the trend at 20 while total reflects all retained results', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      status: (i % 2 === 0 ? 'ok' : 'fail') as 'ok' | 'fail',
      ts: new Date(Date.UTC(2026, 5, 2, 0, i)).toISOString(),
    }));
    seed('engine', many);
    const h = buildProbeHistory('engine')!;
    expect(h.trend).toHaveLength(20);
    expect(h.total).toBe(25);
  });
});
