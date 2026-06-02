/**
 * Diagnose probe persistence (#1540).
 *
 * Every on-demand `runDiagnose` call side-writes each probe's result to
 * the HealthStore, keyed by the synthetic `diagnose:<probeId>` check id.
 * Before #1540 only the daily scheduler / per-row "run now" path
 * (`runDiagnoseChecks`) persisted — so the ~16 stateless inline probes
 * (engine, pods, failed_units, crash_loop, disk, …) accrued no history
 * from the wizard / `/setup` self-test / MCP `diagnose` tool. Now they
 * do: the frontend (#1541) can show uniform first-seen / last-ok / trend
 * on every row, not just the 4 health-backed probes.
 *
 * This is a **leaf** module on purpose: it imports only the store + types
 * (no `runDiagnose`), so `runDiagnose.ts` can call it without forming the
 * cycle `runDiagnose → diagnoseChecks → runDiagnose` (which would fail
 * the `no-circular` invariant). The diagnose→checks bridge
 * (`diagnoseChecks.ts`, #1423) re-exports the id/status helpers from here.
 *
 * The persisted result carries the typed `DiagnosticProbeResult` payload
 * (#1539) — no new string encoding. The legacy `message`
 * (`encodeDiagnoseMessage`) string-JSON stays attached for backward
 * compatibility with the #1423 Checks-tab popup reader
 * (`decodeDiagnoseMessage`), which is migrated off the string in a later
 * slice; `payload` is the canonical typed source going forward.
 */

import { HealthStore } from '@/lib/health/store';
import type { CheckResult, DiagnosticProbeResult, DiagnosticProbeItem } from '@/lib/health/types';

/** Synthetic-check id prefix. A probe `agent` becomes check `diagnose:agent`. */
export const DIAGNOSE_CHECK_ID_PREFIX = 'diagnose:';

export const isDiagnoseCheckId = (id: string): boolean =>
  id.startsWith(DIAGNOSE_CHECK_ID_PREFIX);

export const diagnoseCheckId = (probeId: string): string =>
  `${DIAGNOSE_CHECK_ID_PREFIX}${probeId}`;

/** Four-way diagnose status as it appears on a probe / persisted payload. */
type DiagnoseProbeStatus = 'ok' | 'warn' | 'fail' | 'info';

/**
 * A per-item sub-finding on a probe, as it appears on a (resolved)
 * `DiagnoseProbe` at persist time: `actions` are full resolved objects,
 * `detail`/`status` are optional. `diagnoseProbeToPayload` normalises
 * this into the typed `DiagnosticProbeItem` (#1539) carried on the
 * persisted `payload`.
 */
export interface PersistableProbeItem {
  id: string;
  label: string;
  detail?: string;
  status?: DiagnoseProbeStatus;
  actions?: { id: string }[];
}

/**
 * Structural shape of the subset of a diagnose probe this module reads.
 * Declared here (no import of the diagnose `DiagnoseProbe` type) to keep
 * this a leaf — a type-only import from `runDiagnose.ts` would still
 * register as a module cycle under dependency-cruiser. Matches the
 * resolved `DiagnoseProbe` (items carry resolved `actions`, not
 * `actionIds`).
 */
export interface PersistableProbe {
  id: string;
  label: string;
  status: DiagnoseProbeStatus;
  detail: string;
  hint?: string;
  actions?: unknown[];
  items?: PersistableProbeItem[];
}

/** Normalise a resolved probe item into the typed payload item shape
 *  (#1539): collapse resolved `actions` back to their ids, default the
 *  optional item fields. */
function toPayloadItem(item: PersistableProbeItem): DiagnosticProbeItem {
  return {
    id: item.id,
    label: item.label,
    detail: item.detail ?? '',
    status: item.status ?? 'info',
    actionIds: (item.actions ?? []).map(a => a.id),
  };
}

/** Message marker so the #1423 Checks-tab popup reader can recognise a
 *  diagnose row's persisted payload and decode the original probe (incl.
 *  four-way status + self-repair actions) without re-running the suite. */
export const DIAGNOSE_MESSAGE_PREFIX = 'diagnose:';

/** Build the persisted result message for a probe: a JSON payload behind
 *  the marker so the popup reader recovers status, detail, hint, actions
 *  and items. Retained alongside the typed `payload` (#1539) for backward
 *  compatibility with the existing decode path. */
export function encodeDiagnoseMessage(probe: PersistableProbe): string {
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
): {
  status?: DiagnoseProbeStatus;
  label?: string;
  detail?: string;
  hint?: string;
  actions?: unknown[];
  items?: unknown[];
} | null {
  if (!message || !message.startsWith(DIAGNOSE_MESSAGE_PREFIX)) return null;
  try {
    return JSON.parse(message.slice(DIAGNOSE_MESSAGE_PREFIX.length));
  } catch {
    return null;
  }
}

/**
 * Collapse a diagnose probe's four-way status onto the Check store's
 * binary `ok | fail`. The Checks tab counters treat `warn`/`fail` as a
 * failing row and `ok`/`info` as ok; the typed `payload.status` (and the
 * legacy encoded message) preserve the original four-way nuance for the
 * row badge.
 */
export function diagnoseStatusToCheckStatus(status: DiagnoseProbeStatus): 'ok' | 'fail' {
  return status === 'fail' || status === 'warn' ? 'fail' : 'ok';
}

/** Build the typed `DiagnosticProbeResult` payload (#1539) for a probe. */
export function diagnoseProbeToPayload(probe: PersistableProbe): DiagnosticProbeResult {
  return {
    status: probe.status,
    detail: probe.detail,
    hint: probe.hint,
    items: probe.items ? probe.items.map(toPayloadItem) : undefined,
  };
}

/**
 * Side-write every probe result to the HealthStore as a synthetic
 * `diagnose:<probeId>` check result, attaching the typed `payload`
 * (#1539). Returns the persisted results so a caller (the daily
 * scheduler) can emit `health:update` for each without re-persisting.
 *
 * Best-effort and synchronous-relative-to-the-caller: `saveResult`
 * already swallows its own write errors (logs, never throws), so a flaky
 * disk never breaks the on-demand diagnose narrative the operator asked
 * for.
 */
export function persistDiagnoseResults(probes: PersistableProbe[]): CheckResult[] {
  const now = new Date().toISOString();
  const results: CheckResult[] = probes.map(probe => ({
    check_id: diagnoseCheckId(probe.id),
    timestamp: now,
    status: diagnoseStatusToCheckStatus(probe.status),
    latency: 0,
    message: encodeDiagnoseMessage(probe),
    payload: diagnoseProbeToPayload(probe),
  }));
  for (const result of results) {
    HealthStore.saveResult(result);
  }
  return results;
}
