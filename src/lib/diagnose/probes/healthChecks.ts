/**
 * `health_checks` probe action — registers a "Run all stale checks"
 * action so operators don't have to navigate to Settings → Health
 * to force a tick when the diagnose page surfaces stale checks.
 *
 * The probe's detection lives inline in the diagnose route (it walks
 * HealthStore looking for enabled checks whose lastResult is null
 * after the 2-min boot grace). This file only contributes the action.
 *
 * Iterates every stale check in parallel; reports per-check pass/fail
 * counts in the toast.
 */

import { HealthStore } from '@/lib/health/store';
import { CheckRunner } from '@/lib/health/runner';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult } from '../actions';

const PROBE_ID = 'health_checks';

async function runAllStale(): Promise<ProbeActionResult> {
  const checks = HealthStore.getChecks();
  const enabled = checks.filter(c => c.enabled !== false);
  // Match the same "stale" filter the probe uses so we only run the
  // ones that surfaced. Running every enabled check on every click
  // would be wasteful for installs with hundreds of checks.
  const STALE_MIN_AGE_MS = 2 * 60_000;
  const stale = enabled.filter(c => {
    if (HealthStore.getLastResult(c.id)) return false;
    const created = c.created_at ? Date.parse(c.created_at) : 0;
    return created > 0 && (Date.now() - created) > STALE_MIN_AGE_MS;
  });
  if (stale.length === 0) {
    return {
      ok: true,
      message: 'No stale checks to run — the probe may have caught a transient state.',
      refresh: true,
    };
  }
  // Run in parallel; CheckRunner.run is independent per-check.
  // Cap concurrent runs implicitly via Promise.allSettled — for the
  // ~10-20 checks a typical install has this is fine.
  const results = await Promise.allSettled(stale.map(c => CheckRunner.run(c)));
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && (r.value as { status?: string }).status === 'pass') {
      passed += 1;
    } else {
      failed += 1;
      if (r.status === 'rejected') {
        logger.warn('diagnose:health_checks', `Stale-check run rejected: ${r.reason}`);
      }
    }
  }
  return {
    ok: failed === 0,
    message: failed === 0
      ? `Ran ${stale.length} stale check${stale.length === 1 ? '' : 's'} — all passed.`
      : `Ran ${stale.length} check${stale.length === 1 ? '' : 's'}: ${passed} passed, ${failed} failed. See Settings → Health for details.`,
    refresh: true,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'run_all_stale',
    label: 'Run stale checks now',
    description:
      'Forces a fresh tick of every enabled check that hasn\'t produced a result yet (older than 2 min). Equivalent to clicking "Run" on each check individually in Settings → Health.',
  },
  runAllStale,
);
