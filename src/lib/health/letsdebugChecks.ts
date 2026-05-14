/**
 * Auto-managed `letsdebug`-type health checks for every public NPM
 * proxy host. Mirrors `domainChecks.ts` (which handles internal
 * reachability) but probes the *internet's* view of each domain via
 * letsdebug.net — surfacing TLS, DNS, port-80, and ACME readiness
 * problems that an internal probe can't see.
 *
 * Phase 2 of the diagnose / health-check rework (#483): the
 * `domain_external_reachability` diagnose probe used to keep its own
 * 24 h in-memory cache + 4 h background sweep. With the check living
 * here, persistence + scheduling + socket broadcast all come for
 * free, and the diagnose probe becomes a thin reader.
 *
 * Convention:
 *   - check.id = `letsdebug:<domain>` so lookups stay deterministic.
 *   - Only public hosts get a check (LAN-only domains have no
 *     internet-side view to probe).
 *   - Interval is 4 h — letsdebug rate-limits aggressively, and a
 *     longer cadence is plenty for "did my public domain break?".
 *     Operators who need a sooner answer click "Refresh now" on the
 *     diagnose row.
 *
 * Idempotent on every call. Called from the same lifecycle points as
 * `syncDomainChecks`: server boot + proxy-host writes.
 */

import { HealthStore } from './store';
import type { CheckConfig } from './types';
import { getConfig, type ProxyHostEntry } from '../config';
import { logger } from '../logger';

const LETSDEBUG_CHECK_INTERVAL_SECONDS = 4 * 60 * 60; // 4 h
const LETSDEBUG_CHECK_PREFIX = 'letsdebug:';

function isLanDomain(domain: string): boolean {
  return domain.endsWith('.home.arpa') || domain.endsWith('.local');
}

function isPublicExposure(entry: ProxyHostEntry): boolean {
  if (entry.exposure) return entry.exposure === 'public';
  return !isLanDomain(entry.domain);
}

function buildCheck(entry: ProxyHostEntry, now: string): CheckConfig {
  return {
    id: `${LETSDEBUG_CHECK_PREFIX}${entry.domain}`,
    name: `External reachability — ${entry.domain}`,
    type: 'letsdebug',
    target: entry.domain,
    interval: LETSDEBUG_CHECK_INTERVAL_SECONDS,
    enabled: true,
    created_at: now,
    nodeName: 'Local',
  };
}

/**
 * Walk the configured proxy hosts and ensure every public one has a
 * matching letsdebug-type health check. Removes letsdebug checks for
 * hosts that have been deleted or flipped from public → LAN.
 *
 * Best-effort: any storage error is logged and swallowed —
 * external-reachability checks are nice-to-have observability, not
 * load-bearing functionality.
 */
export async function syncLetsdebugChecks(): Promise<void> {
  try {
    const config = await getConfig();
    const hosts = config.reverseProxy?.hosts ?? [];
    const existing = HealthStore.getChecks();
    const wanted = new Map<string, ProxyHostEntry>();
    for (const h of hosts) {
      if (isPublicExposure(h)) {
        wanted.set(`${LETSDEBUG_CHECK_PREFIX}${h.domain}`, h);
      }
    }

    const now = new Date().toISOString();

    // Add or refresh
    for (const [id, host] of wanted) {
      const current = existing.find(c => c.id === id);
      const next = buildCheck(host, current?.created_at ?? now);
      // Don't churn the saved record (and bust the result history) if
      // the operator-visible state didn't change.
      if (
        current
        && current.type === next.type
        && current.target === next.target
        && current.interval === next.interval
        && current.enabled === next.enabled
      ) continue;
      HealthStore.saveCheck(next);
    }

    // Remove orphans — any letsdebug check whose domain is no longer
    // in the wanted set (host deleted, or flipped to LAN-only).
    for (const check of existing) {
      if (check.type !== 'letsdebug') continue;
      if (!check.id.startsWith(LETSDEBUG_CHECK_PREFIX)) continue;
      if (!wanted.has(check.id)) {
        HealthStore.deleteCheck(check.id);
      }
    }
  } catch (e) {
    logger.warn(
      'letsdebugChecks',
      `syncLetsdebugChecks failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
