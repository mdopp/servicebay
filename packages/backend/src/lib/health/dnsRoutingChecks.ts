/**
 * DNS-routing-check migration (#1564).
 *
 * The per-domain `dns_routing:<domain>` rows have been collapsed into the
 * canonical `domain:<domain>` check (see `domainChecks.ts` + the `domain`
 * probe), which now subsumes both NPM routing and DoH DNS routing in a
 * single row per domain. This sync no longer *creates* any checks — it
 * only prunes the now-defunct `dns_routing:*` rows (and the older
 * `letsdebug:*` rows) so operators upgrading don't keep stale duplicate
 * rows in Settings → Health.
 *
 * Best-effort: storage errors are logged and swallowed.
 */

import { HealthStore } from './store';
import { logger } from '../logger';

const DNS_ROUTING_CHECK_PREFIX = 'dns_routing:';
const LEGACY_LETSDEBUG_PREFIX = 'letsdebug:';

/**
 * Remove every auto-created `dns_routing:*` check (now subsumed by the
 * `domain` check) and any leftover legacy `letsdebug:*` check.
 */
export async function syncDnsRoutingChecks(): Promise<void> {
  try {
    const existing = HealthStore.getChecks();
    for (const check of existing) {
      if (check.type === 'dns_routing' && check.id.startsWith(DNS_ROUTING_CHECK_PREFIX)) {
        logger.info('dnsRoutingChecks', `Pruning collapsed dns_routing check ${check.id} (#1564 — subsumed by domain check)`);
        HealthStore.deleteCheck(check.id);
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
