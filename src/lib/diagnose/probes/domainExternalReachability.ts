/**
 * `domain_external_reachability` probe — runs letsdebug.net against
 * every public-exposure domain we've registered with NPM, surfacing
 * problems with the internet's view (DNS, port-80 reachability, ACME
 * readiness) that the internal `domain` health check can't see.
 *
 * ## Refresh model
 *
 * Three layers, each respecting letsdebug's rate limit:
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
 * ## Cache TTL
 *
 *   - successful results: 24 h
 *   - transport errors:  10 min (so 429s clear quickly)
 *
 * ## Rate-limit awareness
 *
 * Between submissions in a sweep we wait `SUBMIT_DELAY_MS` (30 s).
 * letsdebug 429s aggressively under repeated unauthenticated
 * submissions; this matches their observed tolerance in practice.
 * Total sweep time for 10 domains: ~5 min, well within the cache
 * TTL.
 */

import { getConfig } from '@/lib/config';
import { runLetsdebugForDomain, type LetsdebugProblem } from '../../letsdebug/client';
import { logger } from '../../logger';
import type { ProbeItem } from '../actions';

export interface DomainExternalReachabilityResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

const CACHE_TTL_OK_MS    = 24 * 60 * 60 * 1000; // 24 h for successful checks
const CACHE_TTL_FAIL_MS  =  10 * 60 * 1000;     // 10 min for transport errors
const SUBMIT_DELAY_MS    =  30 * 1000;          // baseline gap between sweep submissions
const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;   // if letsdebug 429s mid-sweep, pause this long
const SWEEP_INTERVAL_MS  =   4 * 60 * 60 * 1000; // periodic 4-h refresh

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
      `Background sweep starting for ${stale.length} domain(s); ~${Math.ceil((stale.length * SUBMIT_DELAY_MS) / 60_000)} min total.`,
    );
    for (let i = 0; i < stale.length; i++) {
      const { rateLimited } = await probeOne(stale[i]);
      if (rateLimited) {
        // Bail the rest of the sweep — letsdebug just told us to
        // slow down. Wait `RATE_LIMIT_BACKOFF_MS` before any new
        // sweep is allowed. Periodic timer + on-diagnose triggers
        // both check this gate.
        backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        logger.warn(
          'diagnose:domain_external_reachability',
          `letsdebug 429 on ${stale[i]} — pausing sweep, next attempt in ${RATE_LIMIT_BACKOFF_MS / 60_000} min.`,
        );
        return;
      }
      if (i < stale.length - 1) {
        await new Promise(r => setTimeout(r, SUBMIT_DELAY_MS));
      }
    }
  } finally {
    sweepActive = false;
  }
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

  for (const domain of publicDomains) {
    const entry = cache.get(domain);
    if (!entry) {
      pendingCount++;
      const manualUrl = `https://letsdebug.net/?domain=${encodeURIComponent(domain)}&method=http-01`;
      items.push({
        id: domain,
        label: domain,
        detail: `Refresh in progress — re-run diagnose in a few minutes for results. Manual: ${manualUrl}`,
        status: 'info',
        actionIds: [],
      });
      continue;
    }
    if (entry.error) {
      const manualUrl = `https://letsdebug.net/?domain=${encodeURIComponent(domain)}&method=http-01`;
      items.push({
        id: domain,
        label: domain,
        detail: `letsdebug probe could not run automatically (${entry.error.slice(0, 120)}). Open manually: ${manualUrl}`,
        status: 'info',
        actionIds: [],
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
      detail: `${top.name || 'problem'}: ${(top.explanation || '').slice(0, 200)}${entry.submissionUrl ? ` · Report: ${entry.submissionUrl}` : ''}`,
      status: itemStatus,
      actionIds: [],
    });
  }

  if (overall === 'ok' && pendingCount === 0) {
    return {
      status: 'ok',
      detail: `${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'} reachable from the internet.`,
    };
  }

  const parts: string[] = [];
  if (failedCount) parts.push(`${failedCount} fatal`);
  if (warnCount) parts.push(`${warnCount} warning`);
  if (pendingCount) parts.push(`${pendingCount} refreshing`);

  return {
    status: pendingCount > 0 && overall === 'ok' ? 'info' : overall,
    detail: `${parts.join(' · ')} of ${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'}.`,
    hint: 'A diagnose run kicks off a background refresh of every stale domain (one every 30 s to respect letsdebug\'s rate limit). The cache also auto-refreshes every 4 h without operator input. Re-run diagnose after the sweep completes for fresh data.',
    items,
  };
}
