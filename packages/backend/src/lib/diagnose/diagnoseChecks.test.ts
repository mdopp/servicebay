import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CheckResult } from '@/lib/health/types';
import type { DiagnoseProbe } from '@/lib/diagnose/runDiagnose';

// In-memory result store keyed by check_id, mirroring HealthStore's
// on-disk file-per-check layout.
const store = {
  results: new Map<string, CheckResult[]>(),
};

const saveResult = (r: CheckResult) => {
  const arr = store.results.get(r.check_id) ?? [];
  arr.unshift(r);
  store.results.set(r.check_id, arr);
};
vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    saveResult: (r: CheckResult) => saveResult(r),
    getResults: (id: string) => store.results.get(id) ?? [],
    getResultCheckIds: () => Array.from(store.results.keys()),
    getLastResult: (id: string) => store.results.get(id)?.[0] ?? null,
  },
}));

// `runDiagnose` itself now persists each probe (#1540). The mock mirrors
// that side-write so `runDiagnoseChecks` (which reads the persisted
// results back) returns them.
const runDiagnoseMock = vi.fn();
vi.mock('@/lib/diagnose/runDiagnose', () => ({
  runDiagnose: async (node: string) => {
    const res = await runDiagnoseMock(node);
    const now = new Date().toISOString();
    for (const p of res.probes as DiagnoseProbe[]) {
      saveResult({
        check_id: `diagnose:${p.id}`,
        timestamp: now,
        status: p.status === 'fail' || p.status === 'warn' ? 'fail' : 'ok',
        latency: 0,
        message: `diagnose:${JSON.stringify({ status: p.status, label: p.label, detail: p.detail, hint: p.hint, actions: p.actions, items: p.items })}`,
        payload: { status: p.status, detail: p.detail, hint: p.hint, items: p.items },
      });
    }
    return res;
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  DIAGNOSE_INTERVAL_SECONDS,
  diagnoseCheckId,
  isDiagnoseCheckId,
  diagnoseStatusToCheckStatus,
  encodeDiagnoseMessage,
  decodeDiagnoseMessage,
  runDiagnoseChecks,
  getDiagnoseChecksEnriched,
} from './diagnoseChecks';

const probe = (over: Partial<DiagnoseProbe>): DiagnoseProbe => ({
  id: 'agent',
  label: 'Agent reachable',
  status: 'ok',
  detail: 'fine',
  ...over,
});

beforeEach(() => {
  store.results.clear();
  runDiagnoseMock.mockReset();
});

describe('diagnose check ids', () => {
  it('prefixes probe ids and round-trips', () => {
    expect(diagnoseCheckId('pods')).toBe('diagnose:pods');
    expect(isDiagnoseCheckId('diagnose:pods')).toBe(true);
    expect(isDiagnoseCheckId('some-uuid')).toBe(false);
  });
});

describe('diagnoseStatusToCheckStatus', () => {
  it('maps warn and fail to fail, ok and info to ok', () => {
    expect(diagnoseStatusToCheckStatus('ok')).toBe('ok');
    expect(diagnoseStatusToCheckStatus('info')).toBe('ok');
    expect(diagnoseStatusToCheckStatus('warn')).toBe('fail');
    expect(diagnoseStatusToCheckStatus('fail')).toBe('fail');
  });
});

describe('encode/decode diagnose message', () => {
  it('round-trips the four-way status + payload', () => {
    const p = probe({ status: 'warn', detail: 'd', hint: 'h', actions: [{ id: 'a', label: 'A', description: 'x' }] });
    const decoded = decodeDiagnoseMessage(encodeDiagnoseMessage(p));
    expect(decoded?.status).toBe('warn');
    expect(decoded?.detail).toBe('d');
    expect(decoded?.hint).toBe('h');
    expect((decoded?.actions?.[0] as { id: string }).id).toBe('a');
  });

  it('returns null for a non-diagnose message', () => {
    expect(decodeDiagnoseMessage('plain check message')).toBeNull();
    expect(decodeDiagnoseMessage(null)).toBeNull();
    expect(decodeDiagnoseMessage(undefined)).toBeNull();
  });

  it('returns null for a corrupt payload', () => {
    expect(decodeDiagnoseMessage('diagnose:{not json')).toBeNull();
  });
});

describe('runDiagnoseChecks', () => {
  it('persists one synthetic result per probe with prefixed ids', async () => {
    runDiagnoseMock.mockResolvedValue({
      node: 'Local',
      probes: [probe({ id: 'agent', status: 'ok' }), probe({ id: 'pods', status: 'warn' })],
    });
    const results = await runDiagnoseChecks('Local');
    expect(results.map(r => r.check_id)).toEqual(['diagnose:agent', 'diagnose:pods']);
    expect(results[0].status).toBe('ok');
    expect(results[1].status).toBe('fail'); // warn -> fail
    expect(store.results.get('diagnose:pods')).toHaveLength(1);
  });

  it('uses the daily interval constant', () => {
    expect(DIAGNOSE_INTERVAL_SECONDS).toBe(24 * 60 * 60);
  });
});

describe('getDiagnoseChecksEnriched', () => {
  it('reads only diagnose-prefixed result files back as enriched rows', async () => {
    // Seed a non-diagnose result that must be ignored.
    store.results.set('some-uuid', [{ check_id: 'some-uuid', timestamp: 't', status: 'ok' }]);
    runDiagnoseMock.mockResolvedValue({
      node: 'Local',
      probes: [probe({ id: 'pods', status: 'warn', label: 'Pods', detail: 'one down' })],
    });
    await runDiagnoseChecks('Local');

    const rows = getDiagnoseChecksEnriched();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe('diagnose:pods');
    expect(row.name).toBe('Self-diagnose: Pods');
    expect(row.status).toBe('fail');
    expect(row.lastRun).not.toBeNull();
    // The four-way diagnose payload is preserved for the popup slice.
    expect(row.diagnose?.status).toBe('warn');
    expect(row.diagnose?.detail).toBe('one down');
  });

  it('returns no rows before any diagnose run', () => {
    expect(getDiagnoseChecksEnriched()).toEqual([]);
  });
});
