/**
 * Auto-managed `domain`-type health checks for every reverse-proxy host.
 *
 * Source of truth is the **live NPM route table** (`getProxyState().routes`,
 * the same list the Services overview / Network map render). Earlier this
 * synced only from `config.reverseProxy.hosts` — which tracks just the hosts
 * SB *provisioned itself* — so hosts created via service installs never got a
 * check and their dots stayed grey (#1416). Config entries are still folded in
 * (they carry richer `exposure` metadata, and cover the brief window at boot
 * before the agent has populated the route table).
 *
 * Convention: check.id = `domain:<domain>` so the lookup stays deterministic
 * and we never end up with duplicate-but-not-quite checks if a host is renamed.
 *
 * Scheme rule:
 *   - config-backed host → exposure-aware (public → https, LAN → http)
 *   - route-only host     → the route's own TLS flag (`route.ssl`)
 *
 * Public hosts also get `isPublic: true`, which the UI uses to render the
 * on-demand "Run external check" button against letsdebug.net.
 *
 * Idempotent on every call; safe to invoke after each proxy-host write, once
 * at boot, and on a periodic timer to catch hosts NPM gained at runtime.
 */

import { HealthStore } from './store';
import type { CheckConfig } from './types';
import { getConfig, type ProxyHostEntry } from '../config';
import { getProxyState } from '../store/repository';
import type { ProxyRoute } from '../agent/types';
import { logger } from '../logger';

const DOMAIN_CHECK_INTERVAL_SECONDS = 60;
const DOMAIN_CHECK_PREFIX = 'domain:';

function isLanDomain(domain: string): boolean {
  return domain.endsWith('.home.arpa') || domain.endsWith('.local');
}

/**
 * Only real FQDNs get a domain check. NPM's own admin entries
 * ("nginxproxymanager", "localhost-nginx-proxy-manager") and any bare
 * hostname without a dot are skipped — they aren't user-facing domains.
 */
function isCheckableDomain(host: string): boolean {
  return host.includes('.') && !host.startsWith('localhost');
}

function isManagedDomainCheck(check: CheckConfig): boolean {
  return check.type === 'domain' && check.id.startsWith(DOMAIN_CHECK_PREFIX);
}

/**
 * Source of truth for "is this entry public or LAN-only?":
 *   1. Persisted `entry.exposure` (set since the publicDomain LAN switch).
 *   2. Fallback to the legacy suffix heuristic for older entries.
 */
function isPublicExposure(entry: ProxyHostEntry): boolean {
  if (entry.exposure) return entry.exposure === 'public';
  return !isLanDomain(entry.domain);
}

/** Build a check from an SB-managed config host entry (exposure-aware). */
function buildCheckFromConfig(entry: ProxyHostEntry, createdAt: string): CheckConfig {
  const isPublic = isPublicExposure(entry);
  return {
    id: `${DOMAIN_CHECK_PREFIX}${entry.domain}`,
    name: `Domain — ${entry.domain}`,
    type: 'domain',
    target: entry.domain,
    interval: DOMAIN_CHECK_INTERVAL_SECONDS,
    enabled: true,
    created_at: createdAt,
    nodeName: 'Local',
    domainConfig: {
      expectedScheme: isPublic ? 'https' : 'http',
      isPublic,
      upstreamPort: entry.forwardPort,
    },
  };
}

/**
 * Build a check from a live NPM route that has no config entry — derive the
 * scheme from the route's own TLS flag and the public hint from the domain
 * suffix (route data carries no exposure metadata).
 */
function buildCheckFromRoute(route: ProxyRoute, createdAt: string): CheckConfig {
  const isPublic = !isLanDomain(route.host);
  return {
    id: `${DOMAIN_CHECK_PREFIX}${route.host}`,
    name: `Domain — ${route.host}`,
    type: 'domain',
    target: route.host,
    interval: DOMAIN_CHECK_INTERVAL_SECONDS,
    enabled: true,
    created_at: createdAt,
    nodeName: 'Local',
    domainConfig: {
      expectedScheme: route.ssl ? 'https' : 'http',
      isPublic,
      upstreamPort: route.targetPort,
    },
  };
}

/** Operator-visible equality — don't churn the saved record (and bust the
 *  result history) when nothing the operator sees has changed. */
function sameDomainCheck(a: CheckConfig, b: CheckConfig): boolean {
  return a.type === b.type
    && a.target === b.target
    && a.interval === b.interval
    && a.enabled === b.enabled
    && a.domainConfig?.expectedScheme === b.domainConfig?.expectedScheme
    && a.domainConfig?.isPublic === b.domainConfig?.isPublic
    && a.domainConfig?.upstreamPort === b.domainConfig?.upstreamPort;
}

/**
 * Union of domains that should have a check: every checkable NPM route host
 * (live truth), plus any config host (covers the boot window before the agent
 * has populated the route table). Config wins on overlap — it carries the
 * exposure metadata a raw route lacks.
 */
function computeWantedChecks(
  routes: ProxyRoute[],
  configByDomain: Map<string, ProxyHostEntry>,
  createdAt: (id: string) => string,
): Map<string, CheckConfig> {
  const wanted = new Map<string, CheckConfig>();
  for (const route of routes) {
    if (!isCheckableDomain(route.host)) continue;
    const id = `${DOMAIN_CHECK_PREFIX}${route.host}`;
    const cfg = configByDomain.get(route.host);
    wanted.set(id, cfg ? buildCheckFromConfig(cfg, createdAt(id)) : buildCheckFromRoute(route, createdAt(id)));
  }
  for (const [domain, entry] of configByDomain) {
    if (!isCheckableDomain(domain)) continue;
    const id = `${DOMAIN_CHECK_PREFIX}${domain}`;
    if (!wanted.has(id)) wanted.set(id, buildCheckFromConfig(entry, createdAt(id)));
  }
  return wanted;
}

/**
 * Ensure every reverse-proxy host has a matching `domain`-type health check,
 * and remove checks for hosts that no longer exist. Best-effort: any storage
 * error is logged and swallowed — domain checks are observability, not
 * load-bearing.
 */
export async function syncDomainChecks(): Promise<void> {
  try {
    const config = await getConfig();
    const configByDomain = new Map<string, ProxyHostEntry>();
    for (const h of config.reverseProxy?.hosts ?? []) configByDomain.set(h.domain, h);

    const routes = getProxyState().routes ?? [];
    const existing = HealthStore.getChecks();
    const now = new Date().toISOString();
    const createdAt = (id: string) => existing.find(c => c.id === id)?.created_at ?? now;

    const wanted = computeWantedChecks(routes, configByDomain, createdAt);

    // Add or refresh.
    for (const next of wanted.values()) {
      const current = existing.find(c => c.id === next.id);
      if (!current || !sameDomainCheck(current, next)) HealthStore.saveCheck(next);
    }

    // Remove orphans — but ONLY when we actually have a route view. A
    // transient empty snapshot (agent not yet polled) must never wipe the
    // existing checks.
    if (routes.length > 0) {
      for (const check of existing) {
        if (isManagedDomainCheck(check) && !wanted.has(check.id)) HealthStore.deleteCheck(check.id);
      }
    }
  } catch (e) {
    logger.warn('domainChecks', `syncDomainChecks failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
