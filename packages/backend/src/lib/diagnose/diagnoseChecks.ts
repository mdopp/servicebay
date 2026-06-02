/**
 * Diagnose → Checks bridge (#1423, first slice).
 *
 * The diagnose/health rework (v3.35–3.37) deliberately split continuous
 * monitoring (health checks, scheduled + persisted) from on-demand
 * narratives (the diagnose self-test). #1423 re-folds the diagnose
 * probes back into the unified Checks list, but keeps them on a *daily*
 * cadence (the suite shells out to the agent ~10 times, far heavier than
 * a single http/ping check — running it every 60 s would hammer the box).
 *
 * Since #1540 the persistence itself moved into `runDiagnose` (every
 * on-demand call side-writes each probe via `persistDiagnoseResults`),
 * keyed by a deterministic id `diagnose:<probeId>`, so the existing
 * HealthStore / Checks-list plumbing surfaces them with the same per-row
 * stats (status, last-run, history sparkline) as any other check. The
 * probe payload is persisted both as the typed `CheckResult.payload`
 * (#1539) and — for backward compatibility with the popup reader below —
 * encoded in the message behind DIAGNOSE_MESSAGE_PREFIX. This module is
 * now the scheduler tick + the enriched-row reader; the id/status/message
 * helpers live in the leaf `persistDiagnoseResults` (re-exported here so
 * existing importers don't move).
 *
 * Remaining for #1423 (separate slices): the self-repair popup opened
 * from a diagnose row, and a Checks-tab counter refactor that
 * distinguishes warn/info (today they fold into fail/unknown — see
 * `diagnoseStatusToCheckStatus`).
 */

import { HealthStore } from '@/lib/health/store';
import type { CheckResult } from '@/lib/health/types';
import { runDiagnose } from '@/lib/diagnose/runDiagnose';
import {
  DIAGNOSE_CHECK_ID_PREFIX,
  DIAGNOSE_MESSAGE_PREFIX,
  isDiagnoseCheckId,
  diagnoseCheckId,
  diagnoseStatusToCheckStatus,
  encodeDiagnoseMessage,
  decodeDiagnoseMessage,
} from '@/lib/diagnose/persistDiagnoseResults';
import { logger } from '@/lib/logger';

// Re-export the id/status/message helpers from the leaf so existing
// importers (health/service.ts, the run-now route, tests) keep their
// `@/lib/diagnose/diagnoseChecks` import path.
export {
  DIAGNOSE_CHECK_ID_PREFIX,
  DIAGNOSE_MESSAGE_PREFIX,
  isDiagnoseCheckId,
  diagnoseCheckId,
  diagnoseStatusToCheckStatus,
  encodeDiagnoseMessage,
  decodeDiagnoseMessage,
};

/** Daily — the diagnose suite is heavy (multi-probe agent fan-out), so
 *  it runs once a day rather than on the per-minute check cadence. */
export const DIAGNOSE_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * Run the diagnose suite for `nodeName`. `runDiagnose` itself now
 * persists one synthetic check result per probe (#1540), so this tick
 * just reads the freshly-persisted results back out to return them for
 * the scheduler's `health:update` SSE emit. Called daily by the
 * HealthService scheduler and on-demand by the per-row "run now" action.
 */
export async function runDiagnoseChecks(
  nodeName = 'Local',
): Promise<CheckResult[]> {
  const { probes } = await runDiagnose(nodeName);
  const results = probes
    .map(probe => HealthStore.getLastResult(diagnoseCheckId(probe.id)))
    .filter((r): r is CheckResult => r !== null);
  logger.info('Diagnose', `Persisted ${results.length} diagnose probe result(s) as checks.`);
  return results;
}

/**
 * Read the diagnose probes back out of the HealthStore as enriched check
 * rows (the shape `/api/health/checks` returns for real checks). Only
 * probes that have a persisted result appear — a fresh box shows none
 * until the first daily run (or an on-demand run) lands.
 */
export function getDiagnoseChecksEnriched() {
  // We can't enumerate probe ids without running the suite, so we list
  // every persisted result whose id carries the diagnose prefix. The
  // store keys results by check_id on disk; HealthStore doesn't expose a
  // "list result files" API, so we reconstruct from the on-disk result
  // listing via getResultCheckIds.
  const ids = HealthStore.getResultCheckIds().filter(isDiagnoseCheckId);
  return ids.map(id => {
    const results = HealthStore.getResults(id);
    const last = results[0];
    const decoded = decodeDiagnoseMessage(last?.message);
    const history = results.slice(0, 20).map(r => ({
      status: r.status,
      latency: r.latency ?? 0,
      timestamp: r.timestamp,
    }));
    return {
      id,
      name: decoded?.label ? `Self-diagnose: ${decoded.label}` : id,
      type: 'script' as const,
      target: id.slice(DIAGNOSE_CHECK_ID_PREFIX.length),
      interval: DIAGNOSE_INTERVAL_SECONDS,
      enabled: true,
      created_at: new Date(0).toISOString(),
      status: last ? last.status : ('unknown' as const),
      lastRun: last ? last.timestamp : null,
      lastResult: last?.message ?? null,
      // Surface the four-way diagnose status + self-repair payload for
      // the row's badge / popup (the popup slice consumes `diagnose`).
      diagnose: decoded ?? undefined,
      history,
    };
  });
}
