/**
 * DNS resolver labelling for the System health Networks section.
 *
 * The agent reports the box's effective resolver list as raw IPs (read from
 * `resolvectl status` / `/etc/resolv.conf`). Here we classify each one so the
 * operator can see at a glance which resolver does what, and — critically —
 * whether a PUBLIC resolver is configured. A public resolver in the box's
 * list is the #1559 trap: it silently breaks split-horizon `*.<domain>` SSO
 * resolution after a reinstall (the box resolves its own subdomains via the
 * public DNS, which doesn't know the LAN IP). That case must warn.
 */

export type DnsResolverLabel = 'AdGuard' | 'router' | 'public' | 'other';

export interface LabelledResolver {
  address: string;
  label: DnsResolverLabel;
  /** true for the well-known public resolvers (the #1559 trap) */
  isPublic: boolean;
}

export interface DnsResolverSummary {
  resolvers: LabelledResolver[];
  /** true when any configured resolver is a public one */
  hasPublicResolver: boolean;
  source: string;
}

/** Well-known public resolvers (Google, Cloudflare, Quad9). */
const PUBLIC_RESOLVERS = new Set<string>([
  '8.8.8.8',
  '8.8.4.4',
  '1.1.1.1',
  '1.0.0.1',
  '9.9.9.9',
  '149.112.112.112',
  // IPv6 equivalents
  '2001:4860:4860::8888',
  '2001:4860:4860::8844',
  '2606:4700:4700::1111',
  '2606:4700:4700::1001',
  '2620:fe::fe',
  '2620:fe::9',
]);

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr.startsWith('127.') || addr === '::1';
}

/**
 * RFC1918 / LAN-private ranges — the FritzBox (or any LAN router) lives here.
 * IPv6 unique-local (fc00::/7) and link-local (fe80::/10) count as LAN too.
 */
function isPrivate(addr: string): boolean {
  if (addr.includes(':')) {
    const lower = addr.toLowerCase();
    return (
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    );
  }
  const parts = addr.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Label a single resolver address.
 *  - loopback / the box itself → AdGuard (ServiceBay runs AdGuard on the box)
 *  - well-known public resolver → public (the #1559 trap)
 *  - RFC1918 / LAN-private → router (the FritzBox)
 *  - anything else → other
 *
 * `boxAddresses` are this node's own non-internal IPs (from `resources.network`);
 * a resolver matching one of them is the box pointing at its own AdGuard.
 */
export function labelResolver(addr: string, boxAddresses: string[] = []): LabelledResolver {
  if (PUBLIC_RESOLVERS.has(addr)) {
    return { address: addr, label: 'public', isPublic: true };
  }
  if (isLoopback(addr) || boxAddresses.includes(addr)) {
    return { address: addr, label: 'AdGuard', isPublic: false };
  }
  if (isPrivate(addr)) {
    return { address: addr, label: 'router', isPublic: false };
  }
  // A non-private, non-loopback address that isn't a known public resolver is
  // still effectively a public/upstream resolver from the LAN's point of view.
  return { address: addr, label: 'public', isPublic: true };
}

/**
 * Summarise the raw resolver report into labelled rows + a public-resolver
 * warning flag. Tolerant of a missing / empty report.
 */
export function summarizeDnsResolvers(
  report: { servers?: string[]; source?: string } | null | undefined,
  boxAddresses: string[] = [],
): DnsResolverSummary {
  const servers = report?.servers ?? [];
  const resolvers = servers.map(addr => labelResolver(addr, boxAddresses));
  return {
    resolvers,
    hasPublicResolver: resolvers.some(r => r.isPublic),
    source: report?.source ?? 'unknown',
  };
}
