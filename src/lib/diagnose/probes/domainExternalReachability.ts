/**
 * `domain_external_reachability` probe — surfaces what letsdebug.net
 * sees from the internet's view of every public-exposure domain
 * (DNS, port-80 reachability, ACME readiness).
 *
 * Phase 2 of the diagnose / health-check rework (#483): this probe
 * is now a **thin reader** over the health-check subsystem. The
 * actual probing is a `letsdebug`-type health check (4 h interval),
 * managed by `letsdebugChecks.ts` and run by `health/runner.ts`.
 * Result persistence, scheduling, socket broadcast, and rate-limit
 * tolerance all live there — this file just joins the latest
 * results into the diagnose narrative + handles the per-row
 * "Refresh now" action.
 *
 * ## Row rendering rules
 *
 *   - HealthStore has no result for `letsdebug:<domain>` yet
 *     → "⏳ First check pending — runs within a few seconds of boot
 *        or right after a new public domain is added."
 *   - `status='ok'` + empty message
 *     → row is omitted from the items list (healthy, no signal).
 *   - `status='ok' | 'fail'` + `letsdebug:<json>` payload
 *     → parse, render top problem + Report URL + Last checked Xago.
 *   - `status='fail'` + plaintext message (transport error / 429)
 *     → render "letsdebug probe could not run automatically" + the
 *       manual letsdebug URL so the operator can submit by hand.
 *
 * ## Refresh model
 *
 * Two layers:
 *
 *   1. **Scheduled check** (4 h interval) — fires automatically once
 *      a check exists, no operator action needed. The health-check
 *      file watcher re-schedules whenever proxy hosts change.
 *
 *   2. **Per-row `refresh_now` action** — operator clicks, the
 *      dispatcher runs the matching health check synchronously
 *      (bypasses the next-tick wait) and the UI re-fetches diagnose
 *      so the row reflects the new state without a second click.
 */

import { getConfig } from '@/lib/config';
import {
  registerProbeAction,
  type ProbeActionResult,
  type ProbeItem,
} from '../actions';
import { HealthStore } from '@/lib/health/store';
import { CheckRunner } from '@/lib/health/runner';
import { LETSDEBUG_MESSAGE_PREFIX } from '@/lib/health/runner';
import type { CheckResult } from '@/lib/health/types';
import type { LetsdebugProblem } from '@/lib/letsdebug/client';
import { logger } from '@/lib/logger';

const PROBE_ID = 'domain_external_reachability';
const LETSDEBUG_CHECK_PREFIX = 'letsdebug:';

export interface DomainExternalReachabilityResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

function isPublicEntry(entry: { domain: string; exposure?: 'public' | 'lan' }): boolean {
  if (entry.exposure) return entry.exposure === 'public';
  if (!entry.domain) return false;
  return !entry.domain.endsWith('.home.arpa') && !entry.domain.endsWith('.local');
}

function severityForProblem(p: LetsdebugProblem): 'warn' | 'fail' {
  return (p.severity || '').toLowerCase() === 'fatal' ? 'fail' : 'warn';
}

function worst(a: 'ok' | 'warn' | 'fail', b: 'ok' | 'warn' | 'fail'): 'ok' | 'warn' | 'fail' {
  if (a === 'fail' || b === 'fail') return 'fail';
  if (a === 'warn' || b === 'warn') return 'warn';
  return 'ok';
}

/**
 * Compact "X ago" string for the operator-facing "last checked"
 * suffix. Bins coarsen as age grows — minutes <1h, hours <24h, days
 * after. Rounds down so a probe that just landed reads "just now".
 */
function formatRelativeAge(fetchedAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 30)                  return 'just now';
  if (seconds < 60)                  return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)                  return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)                    return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

interface DecodedPayload {
  problems: LetsdebugProblem[];
  submissionUrl: string | null;
}

/** Extract the structured `{ problems, submissionUrl }` payload from
 *  a result message, or null if the message isn't a letsdebug-encoded
 *  one (e.g. a plaintext transport error). */
function decodeMessage(message: string | undefined): DecodedPayload | null {
  if (!message || !message.startsWith(LETSDEBUG_MESSAGE_PREFIX)) return null;
  try {
    const json = message.slice(LETSDEBUG_MESSAGE_PREFIX.length);
    const parsed = JSON.parse(json);
    if (!parsed || !Array.isArray(parsed.problems)) return null;
    return {
      problems: parsed.problems as LetsdebugProblem[],
      submissionUrl: typeof parsed.submissionUrl === 'string' ? parsed.submissionUrl : null,
    };
  } catch {
    return null;
  }
}

async function listPublicDomains(): Promise<string[]> {
  const config = await getConfig();
  const hosts = config.reverseProxy?.hosts ?? [];
  return Array.from(new Set(hosts.filter(isPublicEntry).map(h => h.domain)));
}

export async function checkDomainExternalReachability(): Promise<DomainExternalReachabilityResult> {
  const publicDomains = await listPublicDomains();

  if (publicDomains.length === 0) {
    return {
      status: 'ok',
      detail: 'No public domains configured — external reachability check skipped.',
    };
  }

  let overall: 'ok' | 'warn' | 'fail' = 'ok';
  const items: ProbeItem[] = [];
  let failedCount = 0;
  let warnCount = 0;
  let pendingCount = 0;

  for (const domain of publicDomains) {
    const manualUrl = `https://letsdebug.net/?domain=${encodeURIComponent(domain)}&method=http-01`;
    const checkId = `${LETSDEBUG_CHECK_PREFIX}${domain}`;
    const result: CheckResult | null = HealthStore.getLastResult(checkId);
    if (!result) {
      // No result yet — the check exists (boot-time sync creates it)
      // but its 4 h timer hasn't fired or the first tick is in
      // flight. The operator can click "Refresh now" to skip the
      // wait.
      pendingCount++;
      items.push({
        id: domain,
        label: domain,
        detail: `⏳ First check pending — runs within a few seconds of boot. Manual: ${manualUrl}`,
        status: 'info',
        actionIds: ['refresh_now'],
      });
      continue;
    }
    const ageSuffix = ` · Last checked ${formatRelativeAge(Date.parse(result.timestamp))}`;
    const payload = decodeMessage(result.message);
    if (!payload) {
      // status='fail' with a plaintext message → transport error.
      // status='ok' with no message → healthy, omit row.
      if (result.status === 'ok' && !result.message) continue;
      items.push({
        id: domain,
        label: domain,
        detail: `letsdebug probe could not run automatically (${(result.message ?? 'unknown error').slice(0, 120)}). Open manually: ${manualUrl}${ageSuffix}`,
        status: 'info',
        actionIds: ['refresh_now'],
      });
      continue;
    }
    if (payload.problems.length === 0) continue; // healthy with no payload — omit
    const itemStatus = payload.problems.some(p => severityForProblem(p) === 'fail') ? 'fail' : 'warn';
    overall = worst(overall, itemStatus);
    if (itemStatus === 'fail') failedCount++; else warnCount++;
    const top = payload.problems[0];
    items.push({
      id: domain,
      label: domain,
      detail: `${top.name || 'problem'}: ${(top.explanation || '').slice(0, 200)}${payload.submissionUrl ? ` · Report: ${payload.submissionUrl}` : ''}${ageSuffix}`,
      status: itemStatus,
      actionIds: ['refresh_now'],
    });
  }

  if (overall === 'ok' && pendingCount === 0) {
    return {
      status: 'ok',
      detail: `${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'} reachable from the internet.`,
    };
  }

  const parts: string[] = [];
  if (failedCount)   parts.push(`${failedCount} fatal`);
  if (warnCount)     parts.push(`${warnCount} warning`);
  if (pendingCount)  parts.push(`${pendingCount} pending`);

  return {
    status: pendingCount > 0 && overall === 'ok' ? 'info' : overall,
    detail: `${parts.join(' · ')} of ${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'}.`,
    hint: 'Every public domain runs an external reachability check every 4 h via letsdebug.net. The result lives in the health-check subsystem (Settings → Health) — this row is a join into that data. Click "Refresh now" on any row to bypass the wait and re-probe immediately.',
    items,
  };
}

/**
 * `refresh_now` — operator-initiated single-domain re-probe. Runs
 * the matching letsdebug health check synchronously (10-30 s) and
 * saves the result so the UI's auto-refresh picks up the new state
 * without a second click. Bypasses the next-tick wait — there's no
 * separate rate-limit backoff in Phase 2 because the 4 h interval
 * already keeps us well under letsdebug's threshold.
 */
async function refreshNow({ itemId }: { itemId?: string }): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No domain supplied — nothing to refresh.', refresh: false };
  }
  const checkId = `${LETSDEBUG_CHECK_PREFIX}${itemId}`;
  const check = HealthStore.getChecks().find(c => c.id === checkId);
  if (!check) {
    return {
      ok: false,
      message: `No external-reachability check found for ${itemId}. It should appear automatically — try reloading.`,
      refresh: true,
    };
  }
  try {
    const result = await CheckRunner.run(check);
    if (result.status === 'fail' && !result.message?.startsWith(LETSDEBUG_MESSAGE_PREFIX)) {
      // Plaintext message → transport error (429, timeout, parse fail).
      logger.warn(
        'diagnose:domain_external_reachability',
        `refresh_now for ${itemId} failed: ${result.message}`,
      );
      return {
        ok: false,
        message: `letsdebug couldn't be reached for ${itemId}: ${(result.message ?? 'unknown').slice(0, 160)}`,
        refresh: true,
      };
    }
    const payload = result.message ? decodeMessage(result.message) : null;
    const problemCount = payload?.problems.length ?? 0;
    return {
      ok: true,
      message: problemCount === 0
        ? `${itemId} is reachable from the internet.`
        : `${itemId} has ${problemCount} problem(s) — see the row for details.`,
      refresh: true,
    };
  } catch (e) {
    return {
      ok: false,
      message: `Refresh failed: ${e instanceof Error ? e.message : String(e)}`,
      refresh: false,
    };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'refresh_now',
    label: 'Refresh now',
    description:
      'Re-runs letsdebug for this domain immediately, skipping the wait for the next scheduled check. Takes 10-30 s — the row updates in place when the probe finishes.',
  },
  refreshNow,
);

/**
 * Test-only helpers. Exported for the unit test; production code
 * must not call these (decodeMessage is internal, formatRelativeAge
 * is a presentation helper).
 */
export const _internalsForTesting = {
  formatRelativeAge,
  decodeMessage,
};
