/**
 * Auto-managed `dns_routing`-type health checks for every public NPM
 * proxy host. Replaces `letsdebugChecks.ts` as the *continuous*
 * external view; letsdebug stays available as a per-row on-demand
 * action when the operator wants the full CAA / port-80 / ACME
 * simulation taxonomy.
 *
 * Why we moved off continuous letsdebug:
 *   - letsdebug.net rate-limits by source IP; behind a carrier-NAT
 *     LAN it 429s in practice even at our 4 h cadence (#letsdebug-429).
 *   - The two things operators actually care about continuously are
 *     "does the public DNS still point at me?" and "is my IP
 *     reachable?". DoH answers the first; LE-renewal status (already
 *     covered by `cert_request_failure` / `cert_expiry` checks)
 *     proves the second.
 *
 * Convention:
 *   - check.id = `dns_routing:<domain>` so lookups stay deterministic.
 *   - Only public hosts get a check.
 *   - 15-minute interval is plenty cheap — Cloudflare DoH absorbs
 *     household-grade traffic without complaint and the answer
 *     doesn't change minute-to-minute. Operators who want sooner
 *     confirmation click "Refresh now".
 *
 * Cleanup migration: any pre-existing `letsdebug:<domain>` checks
 * are deleted on first sync, so operators upgrading from earlier
 * versions don't end up with stale red rows in Settings → Health.
 */

import { HealthStore } from './store';
import type { CheckConfig } from './types';
import { getConfig, type ProxyHostEntry } from '../config';
import { logger } from '../logger';

const DNS_ROUTING_CHECK_INTERVAL_SECONDS = 15 * 60; // 15 min
const DNS_ROUTING_CHECK_PREFIX = 'dns_routing:';
const LEGACY_LETSDEBUG_PREFIX = 'letsdebug:';

function isLanDomain(domain: string): boolean {
  return domain.endsWith('.home.arpa') || domain.endsWith('.local');
}

function isPublicExposure(entry: ProxyHostEntry): boolean {
  if (entry.exposure) return entry.exposure === 'public';
  return !isLanDomain(entry.domain);
}

function buildCheck(entry: ProxyHostEntry, now: string): CheckConfig {
  return {
    id: `${DNS_ROUTING_CHECK_PREFIX}${entry.domain}`,
    name: `DNS routing — ${entry.domain}`,
    type: 'dns_routing',
    target: entry.domain,
    interval: DNS_ROUTING_CHECK_INTERVAL_SECONDS,
    enabled: true,
    created_at: now,
    nodeName: 'Local',
  };
}

/**
 * Walk configured proxy hosts and ensure every public one has a
 * matching `dns_routing` check. Removes checks for hosts that have
 * been deleted or flipped to LAN-only. Also one-shots the cleanup of
 * any legacy `letsdebug:*` checks left over from earlier versions.
 *
 * Best-effort: storage errors are logged and swallowed —
 * external-reachability checks are nice-to-have observability, not
 * load-bearing functionality.
 */
function checkNeedsRefresh(current: CheckConfig, next: CheckConfig): boolean {
  return !(
    current.type === next.type
    && current.target === next.target
    && current.interval === next.interval
    && current.enabled === next.enabled
  );
}

export async function syncDnsRoutingChecks(): Promise<void> {
  try {
    const config = await getConfig();
    const hosts = config.reverseProxy?.hosts ?? [];
    const existing = HealthStore.getChecks();
    const wanted = new Map<string, ProxyHostEntry>();
    for (const h of hosts) {
      if (isPublicExposure(h)) {
        wanted.set(`${DNS_ROUTING_CHECK_PREFIX}${h.domain}`, h);
      }
    }

    const now = new Date().toISOString();

    for (const [id, host] of wanted) {
      const current = existing.find(c => c.id === id);
      const next = buildCheck(host, current?.created_at ?? now);
      if (current && !checkNeedsRefresh(current, next)) continue;
      HealthStore.saveCheck(next);
    }

    for (const check of existing) {
      if (check.type === 'dns_routing' && check.id.startsWith(DNS_ROUTING_CHECK_PREFIX)) {
        if (!wanted.has(check.id)) HealthStore.deleteCheck(check.id);
        continue;
      }
      if (check.type === 'letsdebug' && check.id.startsWith(LEGACY_LETSDEBUG_PREFIX)) {
        HealthStore.deleteCheck(check.id);
      }
    }
  } catch (e) {
    logger.warn(
      'dnsRoutingChecks',
      `syncDnsRoutingChecks failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
