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
 *   - For each, resolve A-records over the LAN path (AdGuard, see
 *     `lib/router/lanResolver.ts`) and confirm the set contains the box's
 *     LAN IP.
 *   - A core domain that answers with something other than the box's LAN
 *     IP, or answers *negatively* (NXDOMAIN / no A data), → `fail`
 *     (blocking). This is the gate for the box-verify release hook
 *     (#1561): a reinstall must not be declared green while core service
 *     domains don't resolve to the box.
 *   - A lookup that merely got **no answer** (timeout / resolver error) is
 *     `warn`, never `fail` — see below.
 *
 * On failure the hint points at the stable DNS setup — Pattern A
 * (FritzBox distributes AdGuard directly as DHCP DNS), now the
 * recommended default (memory `user_dns_topology`, reversed 2026-06-02:
 * the old public-fallback Pattern B silently broke all SSO logins on
 * reinstall, #1559).
 *
 * ## Why a timeout is not a failure (#2579)
 *
 * This probe stood red for 37 consecutive runs on the reference box,
 * naming domains that resolve perfectly (`getent`/`dig` both answer with
 * the box IP, and `adguard_rewrites_missing` confirms the `*.<domain>`
 * rewrite). Measured on the box, the named domains were **the tail of this
 * probe's own query list**, and the tail grew from 2 to 8 under load —
 * decisive against any per-domain theory. The cause is that AdGuard Home
 * ships `ratelimit: 20` queries/sec/client with an empty
 * `ratelimit_whitelist`, and enforces it by *dropping* the excess. Firing
 * all ~21 core domains at once from one source IP therefore loses the last
 * few queries of the burst to a self-inflicted timeout, which
 * `resolve4ViaLan` used to flatten to `null` and this probe rendered as
 * "does not resolve (NXDOMAIN / no answer)".
 *
 * Two changes follow from that, and both matter:
 *   1. **Retry an inconclusive lookup once.** A dropped query re-sent a
 *      moment later is far under the limit and answers immediately.
 *   2. **Never report an inconclusive lookup as a failure.** Only a
 *      *definitive* negative answer or a *wrong* address is evidence that
 *      DNS is misconfigured. A timeout is evidence of nothing about DNS
 *      configuration, so it warns and says why — the fix for a slow
 *      resolver is not the fix for a wrong DHCP handout.
 *
 * ## Relationship to the `domain:<host>` health checks
 *
 * These two do **not** check the same fact, so they don't share (and
 * shouldn't share) a resolution path — the apparent contradiction in #2579
 * was this probe overclaiming, not two answers to one question:
 *   - `domain:<host>` (`lib/health/probes/domain.ts`) deliberately avoids
 *     DNS for routing: it fetches `http://<lanIp>:80/` with a `Host:`
 *     header, and for *public* hosts adds a DoH lookup of **public** DNS.
 *   - this probe asks the one thing neither of those covers: does the name
 *     resolve **to the box on the LAN path (AdGuard)**.
 * A green `domain:` row plus a red row here is a coherent state (public DNS
 * fine, LAN DNS broken) and is exactly what this probe exists to surface.
 * What was incoherent was claiming NXDOMAIN on the strength of silence.
 */

import { getConfig, type ProxyHostEntry, type AppConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { resolve4ViaLanDetailed, type LanResolveResult } from '@/lib/router/lanResolver';

const PROBE_ID = 'domain_resolves_to_box';

/** Pause before re-sending a lookup that got no answer. Long enough to leave
 *  the resolver's 1-second rate-limit window, short enough that a 21-domain
 *  probe stays well inside a diagnose run. */
const RETRY_DELAY_MS = 1200;

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
  /** Resolved A-records, or null when nothing was resolved. */
  addresses: string[] | null;
  /** Why the lookup ended as it did — see `LanResolveOutcome`. */
  outcome: LanResolveResult['outcome'];
  code?: string;
  /** True when `addresses` contains the box's LAN IP. */
  resolvesToBox: boolean;
}

/** An outcome that says nothing about whether the name resolves — the query
 *  never got an answer, so the probe must not draw a DNS conclusion from it. */
function isInconclusive(outcome: LanResolveResult['outcome']): boolean {
  return outcome === 'timeout' || outcome === 'error';
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

export interface DomainResolvesToBoxDeps {
  /** Injectable for tests; defaults to the real AdGuard-bound lookup. */
  resolve?: (host: string, lanIp: string) => Promise<LanResolveResult>;
  /** Injectable for tests so the retry path doesn't cost real seconds. */
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** One lookup, retried once when it produced no answer at all. A dropped
 *  query (rate limit) or a momentarily-loaded resolver answers fine on the
 *  second try; a name that genuinely doesn't resolve answers negatively both
 *  times, so the retry costs nothing in the failure case (#2579). */
async function resolveWithRetry(
  domain: string,
  lanIp: string,
  resolve: (host: string, lanIp: string) => Promise<LanResolveResult>,
  retryDelayMs: number,
): Promise<LanResolveResult> {
  const first = await resolve(domain, lanIp);
  if (!isInconclusive(first.outcome)) return first;
  await sleep(retryDelayMs);
  return resolve(domain, lanIp);
}

export async function checkDomainResolvesToBox(
  deps: DomainResolvesToBoxDeps = {},
): Promise<DomainResolvesToBoxResult> {
  const resolve = deps.resolve ?? resolve4ViaLanDetailed;
  const retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;
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
      const { outcome, addresses, code } = await resolveWithRetry(domain, lanIp, resolve, retryDelayMs);
      return {
        domain,
        addresses,
        outcome,
        ...(code ? { code } : {}),
        resolvesToBox: !!addresses && addresses.includes(lanIp),
      };
    }),
  );

  return summarise(resolutions, lanIp);
}

/** Turn the per-domain outcomes into the probe row. Split out so the check
 *  itself stays about *gathering* the answers. */
function summarise(resolutions: DomainResolution[], lanIp: string): DomainResolvesToBoxResult {
  const total = resolutions.length;
  const plural = total === 1 ? '' : 's';
  // A definitive negative answer, or an answer pointing somewhere else, is
  // evidence that DNS is misconfigured. Silence is not (#2579).
  const misconfigured = resolutions.filter(r => !r.resolvesToBox && !isInconclusive(r.outcome));
  const unanswered = resolutions.filter(r => !r.resolvesToBox && isInconclusive(r.outcome));

  if (misconfigured.length === 0 && unanswered.length === 0) {
    return {
      status: 'ok',
      detail: `All ${total} core service domain${plural} resolve to ServiceBay (${lanIp}).`,
    };
  }

  if (misconfigured.length > 0) {
    const lines = misconfigured.map(b =>
      b.addresses === null
        ? `${b.domain} → no such name (${b.code ?? 'NXDOMAIN'}) — the resolver answered, and the answer was "this name does not exist here"`
        : `${b.domain} → ${b.addresses.join(', ')} (expected ${lanIp})`,
    );
    if (unanswered.length > 0) {
      lines.push(
        `(${unanswered.length} further domain${unanswered.length === 1 ? '' : 's'} gave no answer at all and ${unanswered.length === 1 ? 'was' : 'were'} not judged: ${unanswered.map(u => u.domain).join(', ')})`,
      );
    }
    return {
      status: 'fail',
      detail: `${misconfigured.length} of ${total} core service domain${plural} don't resolve to ServiceBay (${lanIp}):\n${lines.join('\n')}`,
      hint:
        'DNS misconfigured — DHCP DNS must point at ServiceBay (Pattern A). The most stable setup is to have the FritzBox hand out ServiceBay\'s IP as the DNS server via DHCP (option 6) so every LAN device resolves *.<your-domain> to the box through AdGuard. Open the "Router DNS routing" probe and click "Configure DHCP to ServiceBay", then re-run this check after devices renew their lease (restart Wi-Fi for an immediate refresh).',
    };
  }

  // Only inconclusive lookups left: the resolver went quiet, twice. That is a
  // resolver-health question, not a DNS-configuration one — say so, and don't
  // send the operator off to reconfigure DHCP for it.
  const lines = unanswered.map(u => `${u.domain} → no answer within the timeout (${u.outcome === 'timeout' ? 'timed out' : `resolver error ${u.code ?? 'unknown'}`}), twice`);
  return {
    status: 'warn',
    detail: `${unanswered.length} of ${total} core service domain${plural} could not be checked — the LAN resolver gave no answer, which is not the same as the name not resolving:\n${lines.join('\n')}`,
    hint:
      'Nothing here says DNS is misconfigured — the lookups simply got no reply, so these domains are unjudged rather than broken. The usual cause is the resolver dropping queries: AdGuard Home enforces a per-client rate limit (Settings → DNS settings → "Limit of requests per second", 20 by default) by discarding the excess, and it applies to the box\'s own bursts too. Raising that limit, or waiting for a moment when the box is not under heavy load, makes the check conclusive. If it stays quiet, check that AdGuard is running and listening on :53.',
  };
}

logger.debug('diagnose:probes', `${PROBE_ID} probe ready (no registered actions — fix lives on router_dns_not_pointing).`);
