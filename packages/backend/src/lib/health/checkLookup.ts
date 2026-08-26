/**
 * One resolver for "what kind of check id is this?" (#2654/#2655, from #2651).
 *
 * `get_health_checks` (and `/api/health/checks`) answer from **two** sources
 * merged at read time (#2615): the stored `checks.json` registry, plus the
 * synthetic `diagnose:<probeId>` rows the diagnose bridge projects out of
 * persisted probe results. The write verbs only ever queried the first one, so
 * every id the list tool surfaced from the second source came back
 * `No check with id "…" found` — the read tool and the write tools disagreed
 * about what exists.
 *
 * The fix is not a second list of "known diagnose ids" — there are ~27 probes
 * and the registry grows — it is to resolve an id against **the same readers
 * the list tool merges**. Membership in the diagnose class is therefore whatever
 * `getDiagnoseChecksEnriched()` returned this instant, so a probe added
 * tomorrow is runnable the moment it is listable, with nothing to keep in step.
 *
 * `scripts/check-invariants.ts` (`health-check-id-lifecycle`) pins that shape:
 * this module must derive from the reader rather than enumerate probe ids, and
 * the write verbs must route through it.
 */

import { HealthStore } from './store';
import type { CheckConfig } from './types';
import {
  DIAGNOSE_CHECK_ID_PREFIX,
  isDiagnoseCheckId,
  getDiagnoseChecksEnriched,
} from '@/lib/diagnose/diagnoseChecks';

/**
 * What an id from `get_health_checks` actually is — one arm per source the
 * list tool merges, plus the honest "neither".
 */
export type ResolvedCheck =
  /** A real row in `checks.json`: runnable by the probe runner, deletable. */
  | { kind: 'stored'; id: string; check: CheckConfig }
  /**
   * A synthetic diagnose row. Never in `checks.json`, so it cannot be deleted —
   * but it CAN be re-run: the whole suite runs and this probe's fresh result is
   * persisted under the same id (the dashboard's #1709 path).
   */
  | { kind: 'diagnose'; id: string; probeId: string }
  /** No source lists it. Every verb must reject it the same way. */
  | { kind: 'unknown'; id: string };

/**
 * Classify a check id against the same two readers `get_health_checks` merges.
 *
 * Order matters only for correctness of the stored arm: a stored check always
 * wins, since `checks.json` is the registry a caller can actually mutate. The
 * diagnose arm is decided by asking the diagnose reader for its current rows —
 * NOT by pattern-matching a probe list — so "listed" and "resolvable" are the
 * same predicate by construction.
 */
export function resolveCheckId(id: string): ResolvedCheck {
  const stored = HealthStore.getChecks().find(c => c.id === id);
  if (stored) return { kind: 'stored', id, check: stored };
  // Cheap prefix guard first so a plain miss doesn't pay for the diagnose read;
  // the prefix alone is NOT sufficient (a probe with no persisted result is not
  // listed, so it must not resolve either).
  if (isDiagnoseCheckId(id) && getDiagnoseChecksEnriched().some(row => row.id === id)) {
    return { kind: 'diagnose', id, probeId: id.slice(DIAGNOSE_CHECK_ID_PREFIX.length) };
  }
  return { kind: 'unknown', id };
}

/**
 * The one rejection message for an id no reader lists. Shared so `run_check_now`
 * and `delete_health_check` fail identically on a nonexistent id — an id that
 * does not exist must not be a 400 in one verb and a success in the other.
 */
export function checkNotFoundMessage(id: string): string {
  return `No check with id "${id}" found. get_health_checks lists every id these tools accept — `
    + 'both the stored checks and the synthetic `diagnose:<probeId>` rows.';
}
