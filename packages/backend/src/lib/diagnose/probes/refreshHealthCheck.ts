/**
 * Shared per-row "Refresh now" handler for the Phase 3b singleton
 * health-check probes (`npm_data_stale`, `cert_expiry`,
 * `cert_request_failure`, `lan_ip_changed_since_install`).
 *
 * Mirrors the Phase 2 letsdebug `refresh_now` action: looks up the
 * matching singleton check by id, runs it synchronously via
 * `CheckRunner.run`, and returns a `ProbeActionResult` that asks the
 * UI to re-fetch so the row updates in place.
 *
 * The four probes inherited the deferred-evaluation problem from the
 * health-check schedule (5–15 min ticks) without inheriting the manual
 * override Phase 2 added; this helper closes that gap with one shared
 * implementation rather than four near-duplicate copies.
 */

import { HealthStore } from '@/lib/health/store';
import { CheckRunner } from '@/lib/health/runner';
import { logger } from '@/lib/logger';
import type { ProbeActionResult, ProbeAction, ProbeActionHandler } from '../actions';
import { registerProbeAction } from '../actions';

/** Build a `refresh_now` ProbeAction + handler for a singleton check. */
export function makeRefreshNowAction(checkId: string, label: string): {
  action: ProbeAction;
  handler: ProbeActionHandler;
} {
  return {
    action: {
      id: 'refresh_now',
      label: 'Refresh now',
      description:
        `Re-runs the ${label} check immediately, skipping the wait for the next scheduled tick. The row updates in place when the check finishes.`,
    },
    handler: async (): Promise<ProbeActionResult> => {
      const check = HealthStore.getChecks().find(c => c.id === checkId);
      if (!check) {
        return {
          ok: false,
          message: `No "${label}" check is registered yet — it should appear automatically on the next agent sync.`,
          refresh: true,
        };
      }
      try {
        await CheckRunner.run(check);
        return { ok: true, message: `${label} re-run.`, refresh: true };
      } catch (e) {
        logger.warn(
          'diagnose:refresh_now',
          `refresh of ${checkId} failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return {
          ok: false,
          message: `Refresh failed: ${e instanceof Error ? e.message : String(e)}`,
          refresh: false,
        };
      }
    },
  };
}

/** Convenience wrapper: build + register the refresh_now action against a probe id. */
export function registerRefreshNow(probeId: string, checkId: string, label: string): void {
  const { action, handler } = makeRefreshNowAction(checkId, label);
  registerProbeAction(probeId, action, handler);
}
