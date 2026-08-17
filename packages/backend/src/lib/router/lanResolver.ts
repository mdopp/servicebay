/**
 * LAN-path DNS resolution (#1672) — resolve a hostname the way a LAN
 * client does: through AdGuard on the box, NOT through the OS resolver.
 *
 * Why a dedicated resolver: the box's own `/etc/resolv.conf` historically
 * carried a public fallback (`8.8.8.8`, #1675). When `domain_resolves_to_box`
 * or `router_dns_not_pointing` used `dns.resolve4` against the OS resolver,
 * a public resolver could answer `ldap.<publicDomain>` with the box's
 * *public* IP (the split-horizon the LAN doesn't have), and the probe
 * false-red'd even though every LAN device — which queries AdGuard — gets
 * the box's LAN IP. AdGuard holds the `*.<publicDomain> → <lanIp>` rewrite,
 * so pointing the lookup at AdGuard reproduces the LAN client's answer.
 *
 * We bind a Node `dns.Resolver` to AdGuard's listeners (`127.0.0.1` and the
 * box's LAN IP, both on :53). No fallback to the system resolver — the
 * point is to bypass any public fallback entirely.
 *
 * ## Why the outcome is typed and not just `string[] | null` (#2579)
 *
 * "No answer arrived" and "the answer was: this name does not exist" are
 * different facts with different causes and different fixes, and collapsing
 * both into `null` made `domain_resolves_to_box` report a *permanent DNS
 * misconfiguration* every time a query merely got dropped. On the reference
 * box that happened on every single run: AdGuard Home ships
 * `ratelimit: 20` (queries per second per client, `ratelimit_whitelist: []`)
 * and it enforces the limit by **silently dropping** the excess packets, so a
 * caller that fans out 21 lookups at once loses the tail of its own burst to
 * a timeout it caused itself.
 *
 * `resolve4ViaLanDetailed` therefore reports *which* of the two happened;
 * `resolve4ViaLan` keeps the old `string[] | null` shape for callers that do a
 * single lookup and genuinely don't care (`router_dns_not_pointing`).
 */

import { Resolver } from 'dns/promises';

const DNS_TIMEOUT_MS = 3000;

/** Why a LAN-path lookup ended the way it did.
 *  - `ok` — the resolver answered with at least one A-record.
 *  - `no-answer` — the resolver answered *negatively* (NXDOMAIN / no A data).
 *    This is a definitive "that name does not resolve here".
 *  - `timeout` — nothing came back in time. Says nothing about the name;
 *    a dropped packet (AdGuard rate limit), a loaded box, or a wedged
 *    resolver all look like this.
 *  - `error` — the resolver failed the query (SERVFAIL, REFUSED, connection
 *    refused …). Also inconclusive about the name itself. */
export type LanResolveOutcome = 'ok' | 'no-answer' | 'timeout' | 'error';

export interface LanResolveResult {
  outcome: LanResolveOutcome;
  /** A-records when `outcome === 'ok'`, otherwise null. */
  addresses: string[] | null;
  /** Underlying resolver error code (`ENOTFOUND`, `ESERVFAIL`, …) when known. */
  code?: string;
}

/** c-ares codes that are a *definitive negative answer* about the name. */
const NEGATIVE_ANSWER_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);
/** c-ares codes that mean "no answer arrived in time". */
const TIMEOUT_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT']);

/** The only thing this module needs from a resolver — narrower than
 *  `Resolver` so a test can hand in a plain object without reproducing
 *  node's overloaded `resolve4` signature. `Resolver` satisfies it. */
export interface LanResolverLike {
  resolve4(hostname: string): Promise<string[]>;
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** AdGuard listens on :53 on both loopback and the box's LAN IP. We try
 *  loopback first (always present on the node), then the LAN IP. */
function adguardServers(lanIp: string): string[] {
  const servers = ['127.0.0.1'];
  if (lanIp && lanIp !== '127.0.0.1') servers.push(lanIp);
  return servers;
}

/** Resolve a hostname's A-records via AdGuard (the LAN path) with a hard
 *  timeout, reporting *why* it ended as it did — see `LanResolveOutcome`.
 *  Callers that must not confuse "dropped/slow" with "does not exist" (the
 *  `domain_resolves_to_box` probe, #2579) use this instead of the
 *  null-returning wrapper below.
 *
 *  `resolverFactory` is injectable for tests; defaults to a fresh
 *  AdGuard-bound `Resolver`. */
export async function resolve4ViaLanDetailed(
  hostname: string,
  lanIp: string,
  resolverFactory: (servers: string[]) => LanResolverLike = defaultLanResolver,
): Promise<LanResolveResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolver = resolverFactory(adguardServers(lanIp));
    const records = await Promise.race([
      resolver.resolve4(hostname),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), DNS_TIMEOUT_MS);
      }),
    ]);
    // An empty A-set is the resolver answering "nothing here" — a negative
    // answer, not a missing one.
    if (records.length > 0) return { outcome: 'ok', addresses: records };
    return { outcome: 'no-answer', addresses: null, code: 'ENODATA' };
  } catch (err) {
    const code = errorCode(err);
    if (code && TIMEOUT_CODES.has(code)) return { outcome: 'timeout', addresses: null, code };
    if (code && NEGATIVE_ANSWER_CODES.has(code)) return { outcome: 'no-answer', addresses: null, code };
    return { outcome: 'error', addresses: null, ...(code ? { code } : {}) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Resolve a hostname's A-records via AdGuard (the LAN path) with a hard
 *  timeout. Returns null on NXDOMAIN / SERVFAIL / timeout / any error —
 *  the caller treats null as "does not resolve via the LAN path".
 *
 *  Only for callers doing a **single** lookup where the distinction doesn't
 *  change the verdict. Anything that reports the reason to a human wants
 *  `resolve4ViaLanDetailed` (#2579).
 *
 *  `resolverFactory` is injectable for tests; defaults to a fresh
 *  AdGuard-bound `Resolver`. */
export async function resolve4ViaLan(
  hostname: string,
  lanIp: string,
  resolverFactory: (servers: string[]) => LanResolverLike = defaultLanResolver,
): Promise<string[] | null> {
  const { addresses } = await resolve4ViaLanDetailed(hostname, lanIp, resolverFactory);
  return addresses;
}

function defaultLanResolver(servers: string[]): Resolver {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  resolver.setServers(servers);
  return resolver;
}
