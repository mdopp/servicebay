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
 */

import { Resolver } from 'dns/promises';

const DNS_TIMEOUT_MS = 3000;

/** AdGuard listens on :53 on both loopback and the box's LAN IP. We try
 *  loopback first (always present on the node), then the LAN IP. */
function adguardServers(lanIp: string): string[] {
  const servers = ['127.0.0.1'];
  if (lanIp && lanIp !== '127.0.0.1') servers.push(lanIp);
  return servers;
}

/** Resolve a hostname's A-records via AdGuard (the LAN path) with a hard
 *  timeout. Returns null on NXDOMAIN / SERVFAIL / timeout / any error —
 *  the caller treats null as "does not resolve via the LAN path".
 *
 *  `resolverFactory` is injectable for tests; defaults to a fresh
 *  AdGuard-bound `Resolver`. */
export async function resolve4ViaLan(
  hostname: string,
  lanIp: string,
  resolverFactory: (servers: string[]) => Pick<Resolver, 'resolve4'> = defaultLanResolver,
): Promise<string[] | null> {
  try {
    const resolver = resolverFactory(adguardServers(lanIp));
    const records = await Promise.race([
      resolver.resolve4(hostname),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS)),
    ]);
    return records.length > 0 ? records : null;
  } catch {
    return null;
  }
}

function defaultLanResolver(servers: string[]): Resolver {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  resolver.setServers(servers);
  return resolver;
}
