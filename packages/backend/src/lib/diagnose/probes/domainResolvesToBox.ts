/**
 * `domain_resolves_to_box` probe (#1563) — the precondition every SSO /
 * OIDC flow silently depends on: do the box's own service domains
 * actually *resolve to the box*?
 *
 * The reinstall login cluster (#1559) traced to `*.dopp.cloud` not
 * resolving to ServiceBay (FritzBox→AdGuard upstream down, DHCP DNS not
 * pointed at AdGuard, AdGuard seeing zero LAN queries). The existing
 * `domain_unreachable` probe checks *reachability* (can we HTTP the
 * route, with a Host: header that bypasses DNS entirely); `router_dns_
 * not_pointing` checks whether *clients* use AdGuard. Neither answers
 * the blunt question "does `ldap.<publicDomain>` resolve to the box?"
 * from the box's own resolver — and when it doesn't, every login fails
 * with a different surface error and nothing blocks.
 *
 * Detection:
 *   - Build the core service domains from `publicDomain`: `ldap.` +
 *     `auth.` (LLDAP + Authelia/OIDC — the SSO precondition) plus every
 *     configured public/internal proxy host. LAN-only hosts (.home.arpa
 *     / .local) are excluded — those resolve through AdGuard rewrites,
 *     not the box's container resolver, so checking them here is a false
 *     negative (see the `domain_unreachable` header).
 *   - For each, `dns.resolve4` against the OS resolver and confirm the
 *     A-record set contains the box's LAN IP.
 *   - Any core domain that doesn't resolve to the box → `fail`
 *     (blocking). This is the gate for the box-verify release hook
 *     (#1561): a reinstall must not be declared green while core service
 *     domains don't resolve to the box.
 *
 * On failure the hint points at the stable DNS setup — Pattern A
 * (FritzBox distributes AdGuard directly as DHCP DNS), now the
 * recommended default (memory `user_dns_topology`, reversed 2026-06-02:
 * the old public-fallback Pattern B silently broke all SSO logins on
 * reinstall, #1559).
 */

import { getConfig, type ProxyHostEntry, type AppConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { resolve4ViaLan } from '@/lib/router/lanResolver';

const PROBE_ID = 'domain_resolves_to_box';

/** SSO-precondition subdomains under `publicDomain` that always need to
 *  resolve to the box, whether or not a proxy host is recorded for them
 *  yet — LLDAP (`ldap`) and Authelia/OIDC (`auth`). Every login depends
 *  on these. */
const CORE_SUBDOMAINS = ['ldap', 'auth'] as const;

export interface DomainResolvesToBoxResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
}

interface DomainResolution {
  domain: string;
  /** Resolved A-records, or null when resolution failed entirely. */
  addresses: string[] | null;
  /** True when `addresses` contains the box's LAN IP. */
  resolvesToBox: boolean;
}

function isLanDomain(domain: string): boolean {
  return domain.endsWith('.home.arpa') || domain.endsWith('.local');
}

/** Build the set of public service domains that must resolve to the box.
 *  Core SSO subdomains (`ldap`/`auth`) under `publicDomain` plus every
 *  configured proxy host that isn't LAN-only. Deduped, order-stable. */
function buildCoreDomains(config: AppConfig): string[] {
  const publicDomain = config.reverseProxy?.publicDomain?.trim();
  const hosts: ProxyHostEntry[] = config.reverseProxy?.hosts ?? [];
  const domains: string[] = [];
  if (publicDomain) {
    for (const sub of CORE_SUBDOMAINS) domains.push(`${sub}.${publicDomain}`);
  }
  for (const h of hosts) {
    if (isLanDomain(h.domain)) continue;
    domains.push(h.domain);
  }
  return Array.from(new Set(domains));
}

export async function checkDomainResolvesToBox(): Promise<DomainResolvesToBoxResult> {
  const config = await getConfig();
  const lanIp = config.reverseProxy?.lanIp;
  if (!lanIp) {
    return {
      status: 'info',
      detail: 'No LAN IP recorded yet — install-time detection hasn\'t run, so there\'s nothing to compare resolved A-records against.',
    };
  }

  const domains = buildCoreDomains(config);
  if (domains.length === 0) {
    return {
      status: 'info',
      detail: 'No public service domains configured — set a public domain (Settings → Reverse Proxy) to enable this check.',
    };
  }

  const resolutions: DomainResolution[] = await Promise.all(
    domains.map(async (domain): Promise<DomainResolution> => {
      // Resolve via the LAN path (AdGuard), not the OS resolver — the OS
      // resolver may carry a public fallback that answers with the box's
      // PUBLIC IP (split-horizon the LAN doesn't see), false-reding a box
      // whose LAN clients all resolve correctly through AdGuard (#1672/#1675).
      const addresses = await resolve4ViaLan(domain, lanIp);
      return {
        domain,
        addresses,
        resolvesToBox: !!addresses && addresses.includes(lanIp),
      };
    }),
  );

  const broken = resolutions.filter(r => !r.resolvesToBox);
  if (broken.length === 0) {
    return {
      status: 'ok',
      detail: `All ${domains.length} core service domain${domains.length === 1 ? '' : 's'} resolve to ServiceBay (${lanIp}).`,
    };
  }

  const lines = broken.map(b =>
    b.addresses === null
      ? `${b.domain} → does not resolve (NXDOMAIN / no answer)`
      : `${b.domain} → ${b.addresses.join(', ')} (expected ${lanIp})`,
  );
  return {
    status: 'fail',
    detail: `${broken.length} of ${domains.length} core service domain${domains.length === 1 ? '' : 's'} don't resolve to ServiceBay (${lanIp}):\n${lines.join('\n')}`,
    hint:
      'DNS misconfigured — DHCP DNS must point at ServiceBay (Pattern A). The most stable setup is to have the FritzBox hand out ServiceBay\'s IP as the DNS server via DHCP (option 6) so every LAN device resolves *.<your-domain> to the box through AdGuard. Open the "Router DNS routing" probe and click "Configure DHCP to ServiceBay", then re-run this check after devices renew their lease (restart Wi-Fi for an immediate refresh).',
  };
}

logger.debug('diagnose:probes', `${PROBE_ID} probe ready (no registered actions — fix lives on router_dns_not_pointing).`);
