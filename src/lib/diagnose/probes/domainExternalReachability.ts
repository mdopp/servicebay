/**
 * `domain_external_reachability` probe — runs letsdebug.net against
 * every public-exposure domain we've registered with NPM, surfacing
 * problems with the internet's view (DNS, port-80 reachability, ACME
 * readiness) that the internal `domain` health check can't see.
 *
 * Internal vs. external split:
 *   - The continuous 60-s `domain` health check answers "ServiceBay
 *     itself can reach <domain>". That catches missing proxy hosts,
 *     wrong scheme, dead backends — but it's blind to router-side
 *     issues because ServiceBay is sitting on the LAN.
 *   - This probe answers "the rest of the internet can reach
 *     <domain>". Catches DNS not pointed at your WAN IP, port 80
 *     not forwarded, IPv6 misconfig, ACME CAA records, etc.
 *
 * Rate-limit etiquette: letsdebug.net 429s aggressively when you
 * submit more than a couple of tests in quick succession. So:
 *   - At most ONE fresh letsdebug submission per diagnose run.
 *     Other domains read from cache (or show "queued").
 *   - The domain picked for the fresh probe is the one whose cache
 *     entry is oldest (or missing) — round-robins naturally across
 *     re-runs without us having to track it explicitly.
 *   - Successful results cached 24 h. Failures (429, 5xx, timeouts)
 *     cached only 10 min so we don't get stuck reporting a stale
 *     transport error.
 *
 * Behaviour:
 *   - status 'info' when no public domains exist (nothing to check)
 *   - status 'ok' when every probe completed and reported no problems
 *   - status 'warn' for non-Fatal problems (e.g. CAA inferiority)
 *   - status 'fail' when at least one Fatal problem is found
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
const MAX_FRESH_PROBES_PER_RUN = 1;

interface CacheEntry {
  fetchedAt: number;
  ok: boolean;
  problems: LetsdebugProblem[];
  submissionUrl: string | null;
  error?: string;
}
const cache = new Map<string, CacheEntry>();

function isPublicDomain(domain: string): boolean {
  if (!domain) return false;
  return !domain.endsWith('.home.arpa') && !domain.endsWith('.local');
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

async function probeNow(domain: string): Promise<CacheEntry> {
  try {
    const result = await runLetsdebugForDomain(domain);
    const entry: CacheEntry = {
      fetchedAt: Date.now(),
      ok: result.problems.length === 0,
      problems: result.problems,
      submissionUrl: result.submissionUrl,
    };
    cache.set(domain, entry);
    return entry;
  } catch (e) {
    const entry: CacheEntry = {
      fetchedAt: Date.now(),
      ok: false,
      problems: [],
      submissionUrl: null,
      error: e instanceof Error ? e.message : String(e),
    };
    cache.set(domain, entry);
    return entry;
  }
}

function pickDomainsToRefresh(allDomains: string[]): string[] {
  // Stale-first ordering. Domains with no cache entry are "fully
  // stale" and tied; ties broken alphabetically for stability.
  const sorted = [...allDomains].sort((a, b) => {
    const ea = cache.get(a);
    const eb = cache.get(b);
    const ta = ea ? ea.fetchedAt : 0;
    const tb = eb ? eb.fetchedAt : 0;
    if (ta !== tb) return ta - tb;
    return a.localeCompare(b);
  });
  return sorted.slice(0, MAX_FRESH_PROBES_PER_RUN);
}

export async function checkDomainExternalReachability(): Promise<DomainExternalReachabilityResult> {
  const config = await getConfig();
  const hosts = config.reverseProxy?.hosts ?? [];
  const publicDomains = Array.from(new Set(hosts.filter(h => isPublicDomain(h.domain)).map(h => h.domain)));

  if (publicDomains.length === 0) {
    return {
      status: 'info',
      detail: 'No public domains configured — external reachability check skipped.',
    };
  }

  const toRefresh = new Set(
    pickDomainsToRefresh(publicDomains.filter(d => !isCacheFresh(cache.get(d) ?? { fetchedAt: 0, ok: false, problems: [], submissionUrl: null, error: 'never-checked' }))),
  );
  logger.info(
    'diagnose:domain_external_reachability',
    `Refreshing ${toRefresh.size} of ${publicDomains.length} public domain(s); others read from cache.`,
  );
  for (const d of toRefresh) {
    await probeNow(d);
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
      items.push({
        id: domain,
        label: domain,
        detail: 'Queued — letsdebug rate-limited; will refresh on the next diagnose run.',
        status: 'info',
        actionIds: [],
      });
      continue;
    }
    if (entry.error) {
      overall = worst(overall, 'warn');
      warnCount++;
      items.push({
        id: domain,
        label: domain,
        detail: `letsdebug probe could not run: ${entry.error.slice(0, 160)}${entry.submissionUrl ? ` · Report: ${entry.submissionUrl}` : ''}`,
        status: 'warn',
        actionIds: [],
      });
      continue;
    }
    if (entry.problems.length === 0) {
      // Healthy — no row.
      continue;
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
  if (pendingCount) parts.push(`${pendingCount} queued`);

  return {
    status: pendingCount > 0 && overall === 'ok' ? 'info' : overall,
    detail: `${parts.join(' · ')} of ${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'}.`,
    hint: 'Most common cause: public port 80 not reachable (router port-forward missing or hairpin issue). Each domain\'s row includes its letsdebug.net report URL — copy + paste to view. Only one fresh probe runs per diagnose run to stay under letsdebug\'s rate limit; re-run diagnose to refresh the next one.',
    items,
  };
}
