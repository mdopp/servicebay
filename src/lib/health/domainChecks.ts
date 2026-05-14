/**
 * Auto-managed `domain`-type health checks for every persisted NPM
 * proxy host (`config.reverseProxy.hosts[]`). The health-check
 * runner already does the heavy lifting (60-s schedule, retention,
 * notifications); this helper just keeps the check list in sync
 * with the host list — adds, removes, and updates the `expectedScheme`
 * when an operator swaps LAN ↔ public.
 *
 * Convention: check.id = `domain:<domain>` so the lookup stays
 * deterministic and we never end up with duplicate-but-not-quite
 * checks if the host gets renamed.
 *
 * Scheme rule (kept here so the UI and runner agree):
 *   - any host whose domain ends with `.home.arpa` → http
 *     (LAN-only routes, served without TLS)
 *   - anything else → https
 *     (public domain → NPM is meant to terminate TLS)
 *
 * Public hosts also get `isPublic: true`, which the UI uses to
 * render the on-demand "Run external check" button against
 * letsdebug.net.
 *
 * Idempotent on every call; safe to invoke after each proxy-host
 * write and once at boot to catch entries that pre-date this
 * feature.
 */

import { HealthStore } from './store';
import type { CheckConfig } from './types';
import { getConfig, type ProxyHostEntry } from '../config';
import { logger } from '../logger';

const DOMAIN_CHECK_INTERVAL_SECONDS = 60;
const DOMAIN_CHECK_PREFIX = 'domain:';

function isLanDomain(domain: string): boolean {
  return domain.endsWith('.home.arpa') || domain.endsWith('.local');
}

function buildCheck(entry: ProxyHostEntry, now: string): CheckConfig {
  const isPublic = !isLanDomain(entry.domain);
  return {
    id: `${DOMAIN_CHECK_PREFIX}${entry.domain}`,
    name: `Domain — ${entry.domain}`,
    type: 'domain',
    target: entry.domain,
    interval: DOMAIN_CHECK_INTERVAL_SECONDS,
    enabled: true,
    created_at: now,
    nodeName: 'Local',
    domainConfig: {
      expectedScheme: isPublic ? 'https' : 'http',
      isPublic,
      upstreamPort: entry.forwardPort,
    },
  };
}

/**
 * Walk the configured proxy hosts and ensure every one has a
 * matching domain-type health check. Removes domain checks for
 * hosts that have been deleted from `config.reverseProxy.hosts`.
 *
 * Best-effort: any storage error is logged and swallowed — domain
 * checks are nice-to-have observability, not load-bearing
 * functionality.
 */
export async function syncDomainChecks(): Promise<void> {
  try {
    const config = await getConfig();
    const hosts = config.reverseProxy?.hosts ?? [];
    const existing = HealthStore.getChecks();
    const wanted = new Map<string, ProxyHostEntry>();
    for (const h of hosts) wanted.set(`${DOMAIN_CHECK_PREFIX}${h.domain}`, h);

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
        && current.domainConfig?.expectedScheme === next.domainConfig?.expectedScheme
        && current.domainConfig?.isPublic === next.domainConfig?.isPublic
        && current.domainConfig?.upstreamPort === next.domainConfig?.upstreamPort
      ) continue;
      HealthStore.saveCheck(next);
    }

    // Remove orphans
    for (const check of existing) {
      if (check.type !== 'domain') continue;
      if (!check.id.startsWith(DOMAIN_CHECK_PREFIX)) continue;
      if (!wanted.has(check.id)) {
        HealthStore.deleteCheck(check.id);
      }
    }
  } catch (e) {
    logger.warn('domainChecks', `syncDomainChecks failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
