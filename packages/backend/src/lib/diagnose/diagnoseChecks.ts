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
 * This module is the foundational slice: it runs `runDiagnose` once,
 * then persists each probe as a synthetic check result keyed by a
 * deterministic id `diagnose:<probeId>`, so the existing HealthStore /
 * Checks-list plumbing surfaces them with the same per-row stats
 * (status, last-run, history sparkline) as any other check. The full
 * probe payload (warn/info status + self-repair actions) is encoded in
 * the persisted message behind DIAGNOSE_MESSAGE_PREFIX so a later slice
 * can render the self-repair popup from the row without re-running the
 * suite.
 *
 * Remaining for #1423 (separate slices): the self-repair popup opened
 * from a diagnose row, and a Checks-tab counter refactor that
 * distinguishes warn/info (today they fold into fail/unknown — see
 * `diagnoseStatusToCheckStatus`).
 */

import { HealthStore } from '@/lib/health/store';
import type { CheckResult } from '@/lib/health/types';
import { runDiagnose, type DiagnoseProbe } from '@/lib/diagnose/runDiagnose';
import { logger } from '@/lib/logger';

/** Daily — the diagnose suite is heavy (multi-probe agent fan-out), so
 *  it runs once a day rather than on the per-minute check cadence. */
export const DIAGNOSE_INTERVAL_SECONDS = 24 * 60 * 60;

/** Synthetic-check id prefix. A probe `agent` becomes check `diagnose:agent`. */
export const DIAGNOSE_CHECK_ID_PREFIX = 'diagnose:';

/** Message marker so the Checks UI / popup slice can recognise a diagnose
 *  row's persisted payload and decode the original probe (incl. warn/info
 *  status + self-repair actions) without re-running the suite. */
export const DIAGNOSE_MESSAGE_PREFIX = 'diagnose:';

export const isDiagnoseCheckId = (id: string): boolean =>
  id.startsWith(DIAGNOSE_CHECK_ID_PREFIX);

export const diagnoseCheckId = (probeId: string): string =>
  `${DIAGNOSE_CHECK_ID_PREFIX}${probeId}`;

/**
 * Collapse a diagnose probe's four-way status onto the Check store's
 * three-way `ok | fail | unknown`. The existing Checks tab only knows
 * those three; until the counter refactor (the #1423 follow-up slice)
 * lands, `warn`/`fail` both read as a failing row and `info` reads as
 * `unknown`. The original four-way status is preserved verbatim in the
 * encoded payload, so no information is lost — only the colour the
 * legacy counters assign.
 */
export function diagnoseStatusToCheckStatus(
  status: DiagnoseProbe['status'],
): 'ok' | 'fail' {
  // CheckResult.status is binary (ok | fail); `info` rows have no
  // result-level failure but aren't "ok" either — the enrichment layer
  // maps a missing/absent result to `unknown`, but a diagnose `info`
  // probe HAS run, so we persist it as `ok` and let the decoded payload
  // carry the `info` nuance for the row's badge.
  return status === 'fail' || status === 'warn' ? 'fail' : 'ok';
}

/** Build the persisted result message for a probe: a JSON payload behind
 *  the marker so a reader can recover the full four-way status, detail,
 *  hint and actions. */
export function encodeDiagnoseMessage(probe: DiagnoseProbe): string {
  const payload = {
    status: probe.status,
    label: probe.label,
    detail: probe.detail,
    hint: probe.hint,
    actions: probe.actions,
    items: probe.items,
  };
  return `${DIAGNOSE_MESSAGE_PREFIX}${JSON.stringify(payload)}`;
}

/** Inverse of {@link encodeDiagnoseMessage}. Returns null when the
 *  message isn't a diagnose payload (e.g. a plain check). */
export function decodeDiagnoseMessage(
  message: string | null | undefined,
): Partial<DiagnoseProbe> | null {
  if (!message || !message.startsWith(DIAGNOSE_MESSAGE_PREFIX)) return null;
  try {
    return JSON.parse(message.slice(DIAGNOSE_MESSAGE_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Run the diagnose suite for `nodeName` and persist one synthetic check
 * result per probe. Called daily by the HealthService scheduler and
 * on-demand by the per-row "run now" action. Returns the persisted
 * results so callers can emit `health:update` for them.
 */
export async function runDiagnoseChecks(
  nodeName = 'Local',
): Promise<CheckResult[]> {
  const { probes } = await runDiagnose(nodeName);
  const now = new Date().toISOString();
  const results: CheckResult[] = probes.map(probe => ({
    check_id: diagnoseCheckId(probe.id),
    timestamp: now,
    status: diagnoseStatusToCheckStatus(probe.status),
    latency: 0,
    message: encodeDiagnoseMessage(probe),
  }));
  for (const result of results) {
    HealthStore.saveResult(result);
  }
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
