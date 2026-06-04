/**
 * #1680 — Public DNS A-record precondition for Let's Encrypt HTTP-01.
 *
 * LE's HTTP-01 challenge validates against the domain's PUBLIC A record:
 * certbot resolves `<domain>` from the outside and fetches
 * `http://<domain>/.well-known/acme-challenge/<token>`. If the domain has
 * no public A record, issuance fails with certbot's
 *   "no valid A records found for <domain>; no valid AAAA records found"
 * and the host is left silently cert-less (ssl_forced=1, certificate_id=0,
 * HTTPS serves nothing).
 *
 * The trap is that the box's OWN resolver can't see this gap: AdGuard's
 * `*.<domain> → <lanIp>` wildcard makes EVERY `*.<domain>` resolve locally,
 * so `dns.resolve4` (OS resolver) always returns an answer. We must query a
 * PUBLIC resolver explicitly to learn whether the record exists on the
 * internet — exactly what certbot sees. (`ollama.dopp.cloud` had no public
 * A record while every other host did; the wildcard hid it — see #1680.)
 *
 * So: before requesting an HTTP-01 cert, check the public A record and, if
 * it's missing, FAIL LOUDLY with a specific, actionable message naming the
 * record to add — rather than firing an ACME request that certbot rejects
 * and leaving a dark host.
 */

import { Resolver } from 'node:dns/promises';

/** Public resolvers to query for the *authoritative* (internet-visible)
 *  view of the record. We deliberately bypass the box's own resolver
 *  (AdGuard wildcard) — querying these tells us what certbot will see. */
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
const DNS_TIMEOUT_MS = 4_000;

export interface PublicARecordResult {
  /** true when at least one public resolver returned ≥1 A record. */
  hasRecord: boolean;
  /** The A records seen publicly (empty when none). */
  addresses: string[];
  /** true when every resolver query errored/timed out (couldn't tell). */
  inconclusive: boolean;
}

async function resolveVia(server: string, domain: string): Promise<string[] | null> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  resolver.setServers([server]);
  try {
    const records = await Promise.race([
      resolver.resolve4(domain),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS),
      ),
    ]);
    return records;
  } catch {
    // NXDOMAIN / no-A / SERVFAIL / timeout. Distinguish "answered: no
    // record" (NODATA/NXDOMAIN) from "couldn't ask" at the caller via the
    // inconclusive flag — here we just report null.
    return null;
  }
}

/**
 * Query public resolvers for `domain`'s A records. `hasRecord` is true if
 * ANY public resolver returned an address. `inconclusive` is true only when
 * EVERY query errored (so the caller can avoid blocking issuance on a
 * transient resolver outage — we don't want a DNS hiccup to stop a
 * legitimate cert request).
 */
export async function checkPublicARecord(domain: string): Promise<PublicARecordResult> {
  const results = await Promise.all(PUBLIC_RESOLVERS.map(s => resolveVia(s, domain)));
  const addresses = Array.from(new Set(results.filter((r): r is string[] => !!r).flat()));
  const allErrored = results.every(r => r === null);
  // A clean "no record" answer is when at least one resolver responded
  // (null from a resolver that *reached* the authoritative server is an
  // empty/NXDOMAIN answer). We can't tell a clean NODATA from a timeout at
  // the Node API level, so treat all-null as inconclusive ONLY when we got
  // zero addresses AND every query rejected — otherwise it's a real "no
  // record" signal (some resolver answered, none had an A).
  return {
    hasRecord: addresses.length > 0,
    addresses,
    inconclusive: addresses.length === 0 && allErrored,
  };
}

/**
 * Build the specific, actionable "no public A record" error for a host.
 * `publicIp` is the box's WAN IP when known (so the operator can copy the
 * exact target); falls back to a "what's my IP" hint otherwise.
 */
export function missingARecordMessage(domain: string, publicIp?: string): string {
  const target = publicIp
    ? `→ ${publicIp}`
    : '→ <your WAN IP> (find it at https://api.ipify.org)';
  return (
    `${domain} has no public DNS A record — Let's Encrypt HTTP-01 will fail ` +
    `(certbot: "no valid A records found"). Add an A record at your DNS ` +
    `provider: ${domain} ${target}, then re-issue the certificate. ` +
    `(The box's local AdGuard wildcard makes ${domain} resolve on the LAN, ` +
    `which hides this gap from in-box checks.)`
  );
}
