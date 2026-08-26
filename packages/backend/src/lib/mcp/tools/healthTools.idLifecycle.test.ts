import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolServer } from './context';

/**
 * #2654/#2655 (split from #2651) — the acceptance test for the whole unit:
 * `get_health_checks`, `delete_health_check` and `run_check_now` must agree
 * about which ids exist, in BOTH directions.
 *
 *   - an id the list tool returns is accepted by both write verbs;
 *   - an id no source lists is rejected identically by both write verbs;
 *   - `run_check_now` on a diagnose id RE-RUNS the probe and returns the fresh
 *     result — a success that returns the stale finding is the failure mode
 *     this closes, not a fix for it.
 */

const stored = vi.hoisted(() => ({
  checks: [] as Record<string, unknown>[],
  diagnose: [] as Record<string, unknown>[],
  deleted: [] as string[],
  savedResults: [] as Record<string, unknown>[],
  ranChecks: [] as unknown[],
  diagnoseRuns: [] as { nodeName: string; manual?: boolean }[],
  /** Bumped by each simulated diagnose run so "fresh" is observable. */
  diagnoseGeneration: 0,
  /** Ids the simulated re-run does NOT report (a retired probe). */
  omitFromRun: [] as string[],
}));

vi.mock('@/lib/health/store', () => ({
  HealthStore: {
    getChecks: () => stored.checks,
    getLastResult: () => null,
    saveCheck: vi.fn(),
    deleteCheck: (id: string) => { stored.deleted.push(id); return true; },
    saveResult: (r: Record<string, unknown>) => { stored.savedResults.push(r); },
  },
}));

vi.mock('@/lib/diagnose/diagnoseChecks', () => ({
  DIAGNOSE_CHECK_ID_PREFIX: 'diagnose:',
  isDiagnoseCheckId: (id: string) => id.startsWith('diagnose:'),
  getDiagnoseChecksEnriched: () => stored.diagnose,
  runDiagnoseChecks: async (nodeName: string, opts: { manual?: boolean } = {}) => {
    stored.diagnoseRuns.push({ nodeName, manual: opts.manual });
    stored.diagnoseGeneration += 1;
    // A real re-run rewrites every probe's persisted result. Model that: the
    // finding flips to ok and the timestamp moves.
    return stored.diagnose.filter(row => !stored.omitFromRun.includes(row.id as string)).map(row => ({
      check_id: row.id,
      status: 'ok',
      timestamp: `2026-08-26T00:00:0${stored.diagnoseGeneration}.000Z`,
      latency: 0,
      message: `run-${stored.diagnoseGeneration}`,
    }));
  },
}));

vi.mock('@/lib/health/runner', () => ({
  CheckRunner: {
    run: async (check: { id: string }) => {
      stored.ranChecks.push(check);
      return { check_id: check.id, status: 'ok', timestamp: '2026-08-26T00:00:00.000Z', latency: 3 };
    },
  },
}));

interface CapturedTool {
  description: string;
  handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}
const tools = new Map<string, CapturedTool>();
const stubServer: ToolServer = {
  tool(name: string, description: string, _schema: unknown, handler: CapturedTool['handler']) {
    tools.set(name, { description, handler });
    return undefined;
  },
};

async function call(name: string, args?: unknown) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} was not registered`);
  const res = args === undefined ? await tool.handler() : await tool.handler(args);
  const text = res.content[0].text;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { isError: res.isError === true, text, parsed };
}

const listIds = async () =>
  ((await call('get_health_checks')).parsed as { id: string }[]).map(r => r.id);

beforeEach(async () => {
  tools.clear();
  stored.deleted = [];
  stored.savedResults = [];
  stored.ranChecks = [];
  stored.diagnoseRuns = [];
  stored.diagnoseGeneration = 0;
  stored.omitFromRun = [];
  stored.checks = [
    { id: 'domain:admin.dopp.cloud', name: 'Domain — admin.dopp.cloud', type: 'domain', target: 'admin.dopp.cloud' },
    { id: '1d2f0bfc-55ef-48a5-949d-a554da0be3d9', name: 'Vault', type: 'http', target: 'http://127.0.0.1:8200' },
  ];
  stored.diagnose = [
    { id: 'diagnose:dangling_proxy', name: 'Self-diagnose: dangling proxy', type: 'diagnose', status: 'fail' },
    { id: 'diagnose:sso_verify', name: 'Self-diagnose: SSO', type: 'diagnose', status: 'ok' },
    { id: 'diagnose:raid', name: 'Self-diagnose: RAID', type: 'diagnose', status: 'fail' },
  ];
  const { registerHealthTools } = await import('./healthTools');
  registerHealthTools({ server: stubServer });
});

describe('the three health tools agree about which ids exist (#2654/#2655)', () => {
  it('EVERY id get_health_checks lists is accepted by run_check_now and delete_health_check', async () => {
    const ids = await listIds();
    // Both id shapes from the #2651 report are in the list.
    expect(ids).toContain('domain:admin.dopp.cloud');
    expect(ids).toContain('diagnose:dangling_proxy');

    for (const id of ids) {
      const run = await call('run_check_now', { id });
      expect(run.isError, `run_check_now rejected listed id ${id}`).toBe(false);
      const del = await call('delete_health_check', { id });
      expect(del.isError, `delete_health_check rejected listed id ${id}`).toBe(false);
    }
  });

  it('an id NO source lists is rejected the same way by both write verbs', async () => {
    const ghost = 'domain:gone.dopp.cloud';
    expect(await listIds()).not.toContain(ghost);

    const run = await call('run_check_now', { id: ghost });
    const del = await call('delete_health_check', { id: ghost });

    expect(run.isError).toBe(true);
    expect(del.isError).toBe(true);
    // Identical wording — one verb must not 400 while the other succeeds, and
    // the message names the tool that lists what IS accepted.
    expect(del.text).toBe(run.text);
    expect(run.text).toContain('get_health_checks');
  });

  it('a diagnose id with no persisted result is unlisted AND unresolvable — no phantom success', async () => {
    const unlisted = 'diagnose:never_ran';
    expect(await listIds()).not.toContain(unlisted);
    expect((await call('run_check_now', { id: unlisted })).isError).toBe(true);
    expect((await call('delete_health_check', { id: unlisted })).isError).toBe(true);
  });
});

describe('run_check_now on a diagnose id re-runs the probe (#2655)', () => {
  it('dispatches a MANUAL re-run and returns the FRESH result, not the stored one', async () => {
    const first = await call('run_check_now', { id: 'diagnose:dangling_proxy' });
    expect(first.isError).toBe(false);
    expect(stored.diagnoseRuns).toEqual([{ nodeName: 'Local', manual: true }]);
    const r1 = first.parsed as Record<string, unknown>;
    expect(r1.check_id).toBe('diagnose:dangling_proxy');
    // The listed row said `fail`; the re-run's own verdict is what comes back.
    expect(r1.status).toBe('ok');
    expect(r1.message).toBe('run-1');

    // Prove it CHANGED — a second call must return a newer result, not a
    // replay. A run_check_now that reports success without re-running is the
    // exact defect being removed.
    const second = await call('run_check_now', { id: 'diagnose:dangling_proxy' });
    const r2 = second.parsed as Record<string, unknown>;
    expect(r2.message).toBe('run-2');
    expect(r2.timestamp).not.toBe(r1.timestamp);
    expect(stored.diagnoseRuns).toHaveLength(2);
  });

  it('covers the whole diagnose class, not just sso_verify (#1709 was one probe)', async () => {
    for (const row of stored.diagnose) {
      stored.diagnoseRuns = [];
      const res = await call('run_check_now', { id: row.id as string });
      expect(res.isError, `${row.id} was not runnable`).toBe(false);
      expect((res.parsed as { check_id: string }).check_id).toBe(row.id);
      expect(stored.diagnoseRuns[0]?.manual).toBe(true);
    }
  });

  it('a probe that stops reporting on the re-run errors — never another probe\'s result', async () => {
    // The row is listed from an old result file, but the probe is retired, so
    // the fresh run reports nothing for it. Handing back some OTHER probe's
    // result would be worse than failing.
    stored.diagnose = [{ id: 'diagnose:retired_probe' }];
    stored.omitFromRun = ['diagnose:retired_probe'];
    const res = await call('run_check_now', { id: 'diagnose:retired_probe' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('retired_probe');
  });

  it('a stored check still runs through the probe runner and persists its result', async () => {
    const res = await call('run_check_now', { id: '1d2f0bfc-55ef-48a5-949d-a554da0be3d9' });
    expect(res.isError).toBe(false);
    expect(stored.ranChecks).toHaveLength(1);
    expect(stored.savedResults).toHaveLength(1);
    expect(stored.diagnoseRuns).toHaveLength(0);
  });
});

describe('delete_health_check answers honestly per id class (#2655)', () => {
  it('deletes a stored check', async () => {
    const res = await call('delete_health_check', { id: 'domain:admin.dopp.cloud' });
    expect(res.parsed).toEqual({ deleted: 'domain:admin.dopp.cloud' });
    expect(stored.deleted).toEqual(['domain:admin.dopp.cloud']);
  });

  it('a diagnose id is a documented no-op — success, but never a fake `deleted`', async () => {
    const res = await call('delete_health_check', { id: 'diagnose:raid' });
    expect(res.isError).toBe(false);
    const body = res.parsed as Record<string, unknown>;
    expect(body.deleted).toBe(false);
    expect(body.kind).toBe('diagnose');
    expect(body.probeId).toBe('raid');
    expect(String(body.note)).toMatch(/run_check_now/);
    // Nothing was touched in the store — the row is a projection.
    expect(stored.deleted).toEqual([]);
    // And it is still listed afterwards, consistent with `deleted: false`.
    expect(await listIds()).toContain('diagnose:raid');
  });
});
