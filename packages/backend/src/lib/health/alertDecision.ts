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
 * on the first `ok` tick only if the prior streak had reached the
 * threshold — i.e. a fail alert was actually sent.
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
  // immediately-preceding fail streak had reached the alert threshold
  // (otherwise no fail alert was ever sent, so there's nothing to recover).
  const priorFailStreak = countConsecutiveFails(history.slice(1));
  return { alertFailure: false, alertRecovery: priorFailStreak >= threshold };
}
