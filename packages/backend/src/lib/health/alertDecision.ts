import { CheckConfig, CheckResult, CheckType } from './types';

/**
 * Alert-decision logic for health checks (#1651, epic #1650 item A).
 *
 * A health check used to email on its very first `ok → fail` tick, so a
 * single flaky poll (transient DNS, a one-tick timeout) produced a
 * "Check Failed" email immediately followed by "Recovered" — pure noise.
 *
 * The decision now requires N **consecutive** `fail` results before a
 * check is considered "alerting", where N is a per-type default (or an
 * optional per-check override). Recovery only alerts if a fail alert was
 * actually sent for the current failure streak — we never "recover"
 * something that never alerted.
 *
 * Kept as a pure function (no I/O, no side effects) so it stays cheap to
 * unit-test and easy to extend: #1652 (root-cause / cascade suppression)
 * layers its decision on top of this same `AlertDecision` shape.
 */

/**
 * Consecutive `fail` results required before a check alerts, by type.
 *
 *   - domain / dns_routing / http / ping = 3 — network probes are the
 *     flakiest (a single dropped packet or DoH hiccup is noise).
 *   - service / podman / systemd = 2 — local container/unit state; a
 *     one-tick blip during a restart shouldn't page, but two in a row is real.
 *   - backup / cert_expiry / cert_request_failure = 1 — these are not
 *     transient by nature (a missed backup or an expiring cert is true
 *     the instant it's observed), so alert immediately.
 */
export const DEFAULT_FAILURE_THRESHOLDS: Partial<Record<CheckType, number>> = {
  domain: 3,
  dns_routing: 3,
  http: 3,
  ping: 3,
  service: 2,
  podman: 2,
  systemd: 2,
  backup: 1,
  cert_expiry: 1,
  cert_request_failure: 1,
  // An invalid on-disk nginx config is true the instant `nginx -t`
  // observes it — and it will brick the proxy on the next reboot — so
  // alert immediately rather than waiting for consecutive fails (#1678).
  nginx_config_valid: 1,
};

/**
 * Fallback for any check type without an explicit default above. Two
 * consecutive fails is a conservative middle ground — stricter than the
 * legacy first-tick alert, looser than the noisy network probes.
 */
export const FALLBACK_FAILURE_THRESHOLD = 2;

/** Effective threshold for a check: per-check override → per-type default → fallback. */
export function getFailureThreshold(check: CheckConfig): number {
  if (typeof check.failureThreshold === 'number' && check.failureThreshold >= 1) {
    return Math.floor(check.failureThreshold);
  }
  return DEFAULT_FAILURE_THRESHOLDS[check.type] ?? FALLBACK_FAILURE_THRESHOLD;
}

/**
 * Number of consecutive `fail` results at the head of the history.
 * `history` is newest-first (HealthStore.getResults unshifts), and
 * `history[0]` is the just-saved current result.
 */
export function countConsecutiveFails(history: CheckResult[]): number {
  let n = 0;
  for (const r of history) {
    if (r.status !== 'fail') break;
    n++;
  }
  return n;
}

export interface AlertDecision {
  /** Emit a "Check Failed" alert this tick. */
  alertFailure: boolean;
  /** Emit a "Service Recovered" alert this tick. */
  alertRecovery: boolean;
}

/**
 * Decide whether the current tick should fire a failure or recovery alert.
 *
 * @param check    the check config (supplies type + optional override)
 * @param history  persisted results, newest-first, with `history[0]` = the
 *                 just-saved current result.
 *
 * Failure alert fires on the tick where the consecutive-fail streak first
 * **reaches** the threshold (not on every subsequent fail). Recovery fires
 * on the first `ok` tick only if a failure alert was actually emitted during
 * the immediately-preceding fail streak — i.e. some result in that streak
 * carries the persisted `alerted` flag (#1661). The flag is the single
 * source of truth for "did the operator see a failure email": it is set only
 * after BOTH the #1651 threshold and the #1652 root-cause gate passed, so a
 * downstream symptom that was suppressed as a cascade leaf (streak met the
 * threshold but it wasn't the root) never recovers. Falling back to a bare
 * streak≥threshold check would re-introduce the recovery-side storm this
 * decision exists to prevent.
 */
export function decideAlert(check: CheckConfig, history: CheckResult[]): AlertDecision {
  const threshold = getFailureThreshold(check);
  const current = history[0];
  if (!current) return { alertFailure: false, alertRecovery: false };

  if (current.status === 'fail') {
    const streak = countConsecutiveFails(history);
    // Fire exactly once, on the tick the streak hits the threshold.
    return { alertFailure: streak === threshold, alertRecovery: false };
  }

  // current.status === 'ok' → potential recovery. Recover only if the
  // immediately-preceding fail streak actually emitted a failure alert
  // (some result in it is flagged `alerted`). A streak that merely reached
  // the threshold but was root-cause-suppressed (#1652) carries no flag, so
  // it stays silent — keeping the failure and recovery sides symmetric.
  const priorStreak = priorFailStreakResults(history);
  return { alertFailure: false, alertRecovery: priorStreak.some(r => r.alerted === true) };
}

/** The contiguous fail results immediately preceding the head `ok` result. */
function priorFailStreakResults(history: CheckResult[]): CheckResult[] {
  const streak: CheckResult[] = [];
  for (const r of history.slice(1)) {
    if (r.status !== 'fail') break;
    streak.push(r);
  }
  return streak;
}
