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
