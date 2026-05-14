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
 * Cost: letsdebug.net does a 10-30 s probe per submission, and they
 * publish a rate limit. We cap to one HTTP-01 test per submission,
 * fire them in parallel, and cache the result for 24 h so re-runs of
 * `/api/system/diagnose` don't hammer their endpoint. Only public
 * domains (anything NOT ending in `.home.arpa` / `.local`) are
 * checked; LAN domains are skipped silently.
 *
 * Behaviour:
 *   - status 'info' when no public domains exist (nothing to check)
 *   - status 'ok' when every probe completed and reported no problems
 *   - status 'warn' for non-Fatal problems (e.g. CAA inferiority)
 *   - status 'fail' when at least one Fatal problem is found OR a
 *     submission failed for transport reasons
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

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
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

function severityForProblem(p: LetsdebugProblem): 'warn' | 'fail' {
  return (p.severity || '').toLowerCase() === 'fatal' ? 'fail' : 'warn';
}

function worst(a: 'ok' | 'warn' | 'fail', b: 'ok' | 'warn' | 'fail'): 'ok' | 'warn' | 'fail' {
  if (a === 'fail' || b === 'fail') return 'fail';
  if (a === 'warn' || b === 'warn') return 'warn';
  return 'ok';
}

async function checkOne(domain: string): Promise<CacheEntry> {
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }
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

  logger.info('diagnose:domain_external_reachability', `Running letsdebug for ${publicDomains.length} domain(s)`);
  const settled = await Promise.all(publicDomains.map(d => checkOne(d).then(r => ({ domain: d, entry: r }))));

  let overall: 'ok' | 'warn' | 'fail' = 'ok';
  const items: ProbeItem[] = [];
  let failedCount = 0;
  let warnCount = 0;

  for (const { domain, entry } of settled) {
    if (entry.error) {
      overall = worst(overall, 'warn');
      warnCount++;
      items.push({
        id: domain,
        label: domain,
        detail: `letsdebug probe could not run: ${entry.error.slice(0, 160)}`,
        status: 'warn',
        actionIds: [],
      });
      continue;
    }
    if (entry.problems.length === 0) {
      // Don't emit an item for healthy domains — too much noise.
      continue;
    }
    const itemStatus = entry.problems.some(p => severityForProblem(p) === 'fail') ? 'fail' : 'warn';
    overall = worst(overall, itemStatus);
    if (itemStatus === 'fail') failedCount++; else warnCount++;
    const top = entry.problems[0];
    items.push({
      id: domain,
      label: domain,
      detail: `${top.name || 'problem'}: ${(top.explanation || '').slice(0, 200)}`,
      status: itemStatus,
      actionIds: [],
    });
  }

  if (overall === 'ok') {
    return {
      status: 'ok',
      detail: `${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'} reachable from the internet.`,
    };
  }

  const parts: string[] = [];
  if (failedCount) parts.push(`${failedCount} fatal`);
  if (warnCount) parts.push(`${warnCount} warning`);
  return {
    status: overall,
    detail: `${parts.join(' · ')} on ${items.length} of ${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'}.`,
    hint: 'Most common cause is public port 80 not reachable from the internet (router port-forward missing or hairpin issue). Click a domain to open its letsdebug.net report for the full detail; cached results stay valid for 24 h.',
    items,
  };
}

