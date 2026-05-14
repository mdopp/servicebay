/**
 * `domain_external_reachability` probe — runs letsdebug.net against
 * every public-exposure domain we've registered with NPM, surfacing
 * problems with the internet's view (DNS, port-80 reachability, ACME
 * readiness) that the internal `domain` health check can't see.
 *
 * ## Refresh model
 *
 * Four layers, each respecting letsdebug's rate limit:
 *
 *   1. **On every diagnose run** — read the cache as-is, return
 *      immediately. If anything is stale, kick off a non-blocking
 *      background sweep that walks the stale set serially with a
 *      delay between submissions. The diagnose response carries
 *      whatever's currently cached plus a "queued — sweep in
 *      progress" marker for the domains being refreshed.
 *
 *   2. **Periodic background sweep** (every 4 h) — fires the same
 *      walk without operator interaction, so a dashboard left
 *      open overnight wakes up with fresh data. Started once
 *      lazily on the first probe call (or via the explicit
 *      `startBackgroundSweep()` from server boot).
 *
 *   3. **Per-domain in-flight lock** — ensures concurrent diagnose
 *      runs + the periodic timer don't duplicate submissions for
 *      the same domain.
 *
 *   4. **Per-row `refresh_now` action** — operator clicks a row's
 *      "Refresh now" button, the dispatcher calls
 *      `forceRefreshDomain(domain)` which bypasses the 15 min 429
 *      backoff and awaits a single probe. The UI re-runs diagnose
 *      after the action returns, so the row shows the new state
 *      without a second click. Use when the periodic sweep is
 *      paused (rate-limited) or the operator wants confirmation
 *      they just fixed something.
 *
 * ## Cache TTL
 *
 *   - successful results: 24 h
 *   - transport errors:  10 min (so 429s clear quickly)
 *
 * ## Rate-limit awareness
 *
 * No artificial inter-submission delay: each `await probeOne()`
 * already takes 10-30 s (the poll waits for letsdebug's test to
 * complete), so submissions are strictly one-at-a-time anyway.
 * Total sweep time for 10 domains: ~3-5 min, well within the cache
 * TTL. The 429 backoff below is the safety net if letsdebug
 * decides we're going too fast despite that.
 */

import { getConfig } from '@/lib/config';
import { runLetsdebugForDomain, type LetsdebugProblem } from '../../letsdebug/client';
import { logger } from '../../logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

const PROBE_ID = 'domain_external_reachability';

export interface DomainExternalReachabilityResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

const CACHE_TTL_OK_MS    = 24 * 60 * 60 * 1000; // 24 h for successful checks
const CACHE_TTL_FAIL_MS  =  10 * 60 * 1000;     // 10 min for transport errors
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;   // if letsdebug 429s mid-sweep, pause this long
const SWEEP_INTERVAL_MS  =   4 * 60 * 60 * 1000; // periodic 4-h refresh
// No fixed inter-submission delay: each probe already takes 10-30 s
// naturally (the poll waits for letsdebug's test to complete), and
// `await probeOne()` serialises strictly. The earlier 30 s gap was
// overkill and the 429 backoff below catches the only case where we
// need to slow down.

/**
 * When letsdebug returns 429 we hold off until this timestamp. Any
 * sweep that lands during the hold-off bails immediately, and the
 * inline diagnose check skips its auto-trigger. The hold lifts on
 * its own; nothing else has to remember to clear it.
 */
let backoffUntil = 0;

interface CacheEntry {
  fetchedAt: number;
  ok: boolean;
  problems: LetsdebugProblem[];
  submissionUrl: string | null;
  error?: string;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Set<string>();
let sweepActive = false;
let sweepTimer: NodeJS.Timeout | null = null;

function isPublicEntry(entry: { domain: string; exposure?: 'public' | 'lan' }): boolean {
  if (entry.exposure) return entry.exposure === 'public';
  if (!entry.domain) return false;
  return !entry.domain.endsWith('.home.arpa') && !entry.domain.endsWith('.local');
}

function isCacheFresh(entry: CacheEntry): boolean {
  const ttl = entry.error ? CACHE_TTL_FAIL_MS : CACHE_TTL_OK_MS;
  return Date.now() - entry.fetchedAt < ttl;
}

/**
 * Compact "X ago" string for the operator-facing "last checked" suffix
 * on each row. Bins coarsen as age grows — minute granularity is the
 * right resolution at <1h, hour granularity beyond. We round down so
 * a probe that just landed reads "just now" rather than "1 min ago".
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

function severityForProblem(p: LetsdebugProblem): 'warn' | 'fail' {
  return (p.severity || '').toLowerCase() === 'fatal' ? 'fail' : 'warn';
}

function worst(a: 'ok' | 'warn' | 'fail', b: 'ok' | 'warn' | 'fail'): 'ok' | 'warn' | 'fail' {
  if (a === 'fail' || b === 'fail') return 'fail';
  if (a === 'warn' || b === 'warn') return 'warn';
  return 'ok';
}

async function probeOne(domain: string): Promise<{ rateLimited: boolean }> {
  if (inFlight.has(domain)) return { rateLimited: false };
  inFlight.add(domain);
  try {
    const result = await runLetsdebugForDomain(domain);
    cache.set(domain, {
      fetchedAt: Date.now(),
      ok: result.problems.length === 0,
      problems: result.problems,
      submissionUrl: result.submissionUrl,
    });
    return { rateLimited: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    cache.set(domain, {
      fetchedAt: Date.now(),
      ok: false,
      problems: [],
      submissionUrl: null,
      error: msg,
    });
    // Detect 429 by message text — the client throws
    // "letsdebug submission HTTP 429". Any future variant of
    // "rate limit" / "too many" follows the same heuristic.
    const rateLimited = /429|rate.?limit|too.?many/i.test(msg);
    return { rateLimited };
  } finally {
    inFlight.delete(domain);
  }
}

async function listPublicDomains(): Promise<string[]> {
  const config = await getConfig();
  const hosts = config.reverseProxy?.hosts ?? [];
  return Array.from(new Set(hosts.filter(isPublicEntry).map(h => h.domain)));
}

/**
 * Walk every stale public domain in serial with a delay between
 * submissions. Guarded by `sweepActive` so a second caller while
 * the first is still running silently no-ops — the existing sweep
 * is already covering whatever the second caller would want.
 */
async function sweepStaleDomains(): Promise<void> {
  if (sweepActive) return;
  if (Date.now() < backoffUntil) {
    logger.info(
      'diagnose:domain_external_reachability',
      `Sweep skipped — in 429 backoff until ${new Date(backoffUntil).toISOString()}.`,
    );
    return;
  }
  sweepActive = true;
  try {
    const domains = await listPublicDomains();
    const stale = domains
      .filter(d => {
        const entry = cache.get(d);
        return !entry || !isCacheFresh(entry);
      })
      .sort((a, b) => {
        const ta = cache.get(a)?.fetchedAt ?? 0;
        const tb = cache.get(b)?.fetchedAt ?? 0;
        return ta - tb;
      });
    if (stale.length === 0) return;
    logger.info(
      'diagnose:domain_external_reachability',
      `Background sweep starting for ${stale.length} domain(s) — one at a time, each takes 10-30 s.`,
    );
    for (const domain of stale) {
      const { rateLimited } = await probeOne(domain);
      if (rateLimited) {
        // Bail the rest of the sweep — letsdebug just told us to
        // slow down. Wait `RATE_LIMIT_BACKOFF_MS` before any new
        // sweep is allowed. Periodic timer + on-diagnose triggers
        // both check this gate.
        backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        logger.warn(
          'diagnose:domain_external_reachability',
          `letsdebug 429 on ${domain} — pausing sweep, next attempt in ${RATE_LIMIT_BACKOFF_MS / 60_000} min.`,
        );
        return;
      }
    }
  } finally {
    sweepActive = false;
  }
}

/**
 * Operator-initiated single-domain refresh — bypasses both the
 * 4 h cache TTL and the 15 min 429 backoff (the operator is
 * explicitly asking to retry now). Awaits the probe so the
 * caller can re-fetch immediately afterwards and render fresh
 * data. Returns the resulting cache entry.
 *
 * This is the handler behind the `refresh_now` per-row action;
 * exported separately so unit tests can drive it without going
 * through the dispatcher.
 */
export async function forceRefreshDomain(domain: string): Promise<CacheEntry | null> {
  // Clear the backoff gate so this one probe can fire. The gate is
  // only meant to throttle automatic sweeps; if the operator clicks
  // refresh, they want a result, not a "please wait" message. We
  // don't restore the old value — if letsdebug 429s again, the new
  // backoff window starts from this attempt's failure.
  backoffUntil = 0;
  await probeOne(domain);
  return cache.get(domain) ?? null;
}

/**
 * Kick off the periodic sweep timer. Safe to call multiple times —
 * second call is a no-op. server.ts calls this once on boot;
 * `checkDomainExternalReachability` also calls it lazily so the
 * timer exists even on dev runs that bypass server.ts.
 */
export function startBackgroundSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void sweepStaleDomains(); }, SWEEP_INTERVAL_MS);
}

export async function checkDomainExternalReachability(): Promise<DomainExternalReachabilityResult> {
  startBackgroundSweep();
  const publicDomains = await listPublicDomains();

  if (publicDomains.length === 0) {
    return {
      status: 'info',
      detail: 'No public domains configured — external reachability check skipped.',
    };
  }

  // Diagnose-triggered sweep — async, non-blocking. The diagnose
  // response returns whatever's currently cached; the next diagnose
  // run picks up the new state.
  const anyStale = publicDomains.some(d => {
    const e = cache.get(d);
    return !e || !isCacheFresh(e);
  });
  if (anyStale) {
    void sweepStaleDomains();
  }

  let overall: 'ok' | 'warn' | 'fail' = 'ok';
  const items: ProbeItem[] = [];
  let failedCount = 0;
  let warnCount = 0;
  let pendingCount = 0;
  let probingCount = 0;

  for (const domain of publicDomains) {
    const probing = inFlight.has(domain);
    const entry = cache.get(domain);
    const manualUrl = `https://letsdebug.net/?domain=${encodeURIComponent(domain)}&method=http-01`;
    if (!entry) {
      // Differentiate "right now being checked" from "queued for the
      // sweep but hasn't started yet" so the operator sees real
      // progress on a re-run. Cached entries below render their
      // real results regardless of whether this domain is the one
      // currently being probed. `refresh_now` is offered on
      // queued-but-not-yet-running rows so the operator can jump
      // their domain ahead of the sweep without waiting their turn.
      if (probing) {
        probingCount++;
        items.push({
          id: domain,
          label: domain,
          detail: `🔄 Probing now (letsdebug takes 10-30 s per domain). Re-run diagnose in a moment for the result. Manual: ${manualUrl}`,
          status: 'info',
          actionIds: [],
        });
      } else {
        pendingCount++;
        items.push({
          id: domain,
          label: domain,
          detail: `⏳ Queued — waiting its turn in the sweep. Manual: ${manualUrl}`,
          status: 'info',
          actionIds: ['refresh_now'],
        });
      }
      continue;
    }
    const ageSuffix = ` · Last checked ${formatRelativeAge(entry.fetchedAt)}`;
    if (entry.error) {
      items.push({
        id: domain,
        label: domain,
        detail: `letsdebug probe could not run automatically (${entry.error.slice(0, 120)}). Open manually: ${manualUrl}${ageSuffix}`,
        status: 'info',
        actionIds: ['refresh_now'],
      });
      continue;
    }
    if (entry.problems.length === 0) {
      continue; // healthy — no row
    }
    const itemStatus = entry.problems.some(p => severityForProblem(p) === 'fail') ? 'fail' : 'warn';
    overall = worst(overall, itemStatus);
    if (itemStatus === 'fail') failedCount++; else warnCount++;
    const top = entry.problems[0];
    items.push({
      id: domain,
      label: domain,
      detail: `${top.name || 'problem'}: ${(top.explanation || '').slice(0, 200)}${entry.submissionUrl ? ` · Report: ${entry.submissionUrl}` : ''}${ageSuffix}`,
      status: itemStatus,
      actionIds: ['refresh_now'],
    });
  }

  if (overall === 'ok' && pendingCount === 0 && probingCount === 0) {
    return {
      status: 'ok',
      detail: `${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'} reachable from the internet.`,
    };
  }

  const parts: string[] = [];
  if (failedCount)   parts.push(`${failedCount} fatal`);
  if (warnCount)     parts.push(`${warnCount} warning`);
  if (probingCount)  parts.push(`${probingCount} probing`);
  if (pendingCount)  parts.push(`${pendingCount} queued`);

  const stillWorking = pendingCount > 0 || probingCount > 0;
  return {
    status: stillWorking && overall === 'ok' ? 'info' : overall,
    detail: `${parts.join(' · ')} of ${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'}.`,
    hint: 'A diagnose run kicks off a background refresh of every stale domain, one at a time (each probe takes 10-30 s to complete). The cache also auto-refreshes every 4 h without operator input. If letsdebug rate-limits us mid-sweep, a 15 min backoff kicks in automatically. Click "Refresh now" on any row to jump that domain ahead of the queue and ignore the backoff.',
    items,
  };
}

/**
 * `refresh_now` — operator-initiated single-domain re-probe. Bypasses
 * the rate-limit backoff (the operator is explicitly asking for a
 * fresh result). Waits for the probe to complete (10-30 s) so the
 * UI re-fetches diagnose right after and the row already shows the
 * new state — no second click required.
 */
async function refreshNow({ itemId }: { itemId?: string }): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No domain supplied — nothing to refresh.', refresh: false };
  }
  try {
    const entry = await forceRefreshDomain(itemId);
    if (!entry) {
      // probeOne always writes a cache entry (success or error
      // branch); a null here means something went very wrong above
      // the cache layer, e.g. a thrown error we don't catch.
      return {
        ok: false,
        message: `Probe for ${itemId} did not produce a result.`,
        refresh: true,
      };
    }
    if (entry.error) {
      logger.warn(
        'diagnose:domain_external_reachability',
        `refresh_now for ${itemId} failed: ${entry.error}`,
      );
      return {
        ok: false,
        message: `letsdebug couldn't be reached for ${itemId}: ${entry.error.slice(0, 160)}`,
        refresh: true,
      };
    }
    return {
      ok: true,
      message: entry.problems.length === 0
        ? `${itemId} is reachable from the internet.`
        : `${itemId} has ${entry.problems.length} problem(s) — see the row for details.`,
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
      'Re-runs letsdebug for this domain immediately, ignoring the 15 min rate-limit backoff. Takes 10-30 s — the row updates in place when the probe finishes.',
  },
  refreshNow,
);

/**
 * Test-only: reset the in-memory cache + in-flight set + backoff so
 * each unit test starts from a known empty state. Production code
 * must never call this.
 */
export function _resetCacheForTesting(): void {
  cache.clear();
  inFlight.clear();
  backoffUntil = 0;
  sweepActive = false;
}
