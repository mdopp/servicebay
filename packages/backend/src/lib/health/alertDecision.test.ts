/**
 * Alert-decision threshold tests (#1651).
 *
 * A check must see N consecutive fails before it alerts, and may only
 * "recover" if a fail alert was actually sent. N is a per-type default
 * (overridable per check). See `alertDecision.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  decideAlert,
  getFailureThreshold,
  countConsecutiveFails,
  DEFAULT_FAILURE_THRESHOLDS,
  FALLBACK_FAILURE_THRESHOLD,
} from './alertDecision';
import { CheckConfig, CheckResult, CheckType } from './types';

function check(type: CheckType, overrides: Partial<CheckConfig> = {}): CheckConfig {
  return {
    id: 'c1',
    name: 'test',
    type,
    target: 'x',
    interval: 60,
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Build a newest-first history from a status string. Chars:
 *   'o' = ok, 'f' = fail (not alerted), 'A' = fail that emitted an alert
 *   (the persisted `alerted` flag #1661 set by runAndEmit on a root failure).
 * Recovery (#1661) keys on the `alerted` flag, so a fail streak that met the
 * threshold but was root-cause-suppressed uses 'f', and one that actually
 * alerted uses 'A'.
 */
function history(statuses: string): CheckResult[] {
  return statuses.split('').map((s, i) => ({
    check_id: 'c1',
    timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    status: s === 'o' ? 'ok' : 'fail',
    ...(s === 'A' ? { alerted: true } : {}),
  }));
}

describe('getFailureThreshold', () => {
  it('uses per-type defaults', () => {
    expect(getFailureThreshold(check('domain'))).toBe(3);
    expect(getFailureThreshold(check('dns_routing'))).toBe(3);
    expect(getFailureThreshold(check('http'))).toBe(3);
    expect(getFailureThreshold(check('ping'))).toBe(3);
    expect(getFailureThreshold(check('service'))).toBe(2);
    expect(getFailureThreshold(check('podman'))).toBe(2);
    expect(getFailureThreshold(check('systemd'))).toBe(2);
    expect(getFailureThreshold(check('backup'))).toBe(1);
    expect(getFailureThreshold(check('cert_expiry'))).toBe(1);
    expect(getFailureThreshold(check('cert_request_failure'))).toBe(1);
  });

  it('falls back for a type without an explicit default', () => {
    expect(getFailureThreshold(check('script'))).toBe(FALLBACK_FAILURE_THRESHOLD);
    expect(DEFAULT_FAILURE_THRESHOLDS.script).toBeUndefined();
  });

  it('honours a per-check override over the type default', () => {
    expect(getFailureThreshold(check('domain', { failureThreshold: 1 }))).toBe(1);
    expect(getFailureThreshold(check('backup', { failureThreshold: 5 }))).toBe(5);
  });

  it('ignores invalid overrides (<1 or non-integer) and uses the default', () => {
    expect(getFailureThreshold(check('domain', { failureThreshold: 0 }))).toBe(3);
    expect(getFailureThreshold(check('domain', { failureThreshold: -2 }))).toBe(3);
    expect(getFailureThreshold(check('domain', { failureThreshold: 2.7 }))).toBe(2);
  });
});

describe('countConsecutiveFails', () => {
  it('counts the leading fail streak (newest-first)', () => {
    expect(countConsecutiveFails(history('fffo'))).toBe(3);
    expect(countConsecutiveFails(history('off'))).toBe(0);
    expect(countConsecutiveFails(history(''))).toBe(0);
    expect(countConsecutiveFails(history('f'))).toBe(1);
  });
});

describe('decideAlert — failure threshold (#1651)', () => {
  it('does NOT alert on a single fail for a domain check (threshold 3)', () => {
    const d = decideAlert(check('domain'), history('fo'));
    expect(d.alertFailure).toBe(false);
  });

  it('does NOT alert on the second consecutive fail (still below threshold 3)', () => {
    const d = decideAlert(check('domain'), history('ffo'));
    expect(d.alertFailure).toBe(false);
  });

  it('alerts exactly on the third consecutive fail', () => {
    const d = decideAlert(check('domain'), history('fffo'));
    expect(d.alertFailure).toBe(true);
  });

  it('fires the failure alert only once — not on the 4th/5th fail', () => {
    expect(decideAlert(check('domain'), history('ffffo')).alertFailure).toBe(false);
    expect(decideAlert(check('domain'), history('fffffo')).alertFailure).toBe(false);
  });

  it('backup/cert checks alert on the first fail (threshold 1)', () => {
    expect(decideAlert(check('backup'), history('f')).alertFailure).toBe(true);
    expect(decideAlert(check('cert_expiry'), history('fo')).alertFailure).toBe(true);
  });

  it('service checks alert on the second fail (threshold 2)', () => {
    expect(decideAlert(check('service'), history('fo')).alertFailure).toBe(false);
    expect(decideAlert(check('service'), history('ffo')).alertFailure).toBe(true);
  });

  it('a per-check override of 1 restores legacy first-fail behaviour', () => {
    expect(decideAlert(check('domain', { failureThreshold: 1 }), history('fo')).alertFailure).toBe(true);
  });
});

describe('decideAlert — recovery (#1661)', () => {
  it('does NOT recover if no fail alert was ever sent (single flaky fail)', () => {
    // one fail then ok → never alerted → no recovery.
    const d = decideAlert(check('domain'), history('of'));
    expect(d.alertRecovery).toBe(false);
  });

  it('does NOT recover when the prior fail streak was never alerted', () => {
    // fails that were never flagged `alerted` (below threshold OR root-cause
    // suppressed) → no alert was sent → no recovery email.
    const d = decideAlert(check('domain'), history('off'));
    expect(d.alertRecovery).toBe(false);
  });

  it('recovers when the prior fail streak actually alerted', () => {
    // fails reaching the alert (one flagged 'A') then ok → recovery fires.
    const d = decideAlert(check('domain'), history('offA'));
    expect(d.alertRecovery).toBe(true);
    expect(d.alertFailure).toBe(false);
  });

  it('does NOT recover a downstream symptom suppressed by root-cause (#1661)', () => {
    // The fail streak reached the per-type threshold (3 fails) but was
    // root-cause-suppressed, so none carry the `alerted` flag. Symmetric with
    // the failure side: no fail email was sent, so no recovery email either.
    const d = decideAlert(check('domain'), history('offf'));
    expect(d.alertRecovery).toBe(false);
  });

  it('recovers a backup check after its single-fail alert', () => {
    expect(decideAlert(check('backup'), history('oA')).alertRecovery).toBe(true);
  });

  it('does not double-recover (second ok after recovery)', () => {
    // 'ooA…' newest-first: current ok, prev ok → no fail in the prior streak.
    expect(decideAlert(check('domain'), history('ooAAAA')).alertRecovery).toBe(false);
  });

  it('first-ever result (ok, no history) does nothing', () => {
    const d = decideAlert(check('domain'), history('o'));
    expect(d.alertFailure).toBe(false);
    expect(d.alertRecovery).toBe(false);
  });

  it('empty history is inert', () => {
    expect(decideAlert(check('domain'), [])).toEqual({ alertFailure: false, alertRecovery: false });
  });
});
