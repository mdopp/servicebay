import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Loopback ports of the known-local hostNetwork services ServiceBay
 * monitors itself (#1670). A stack's post-deploy registers an HTTP health
 * check against its own loopback endpoint via the internal-token POST
 * (`home-assistant-api` → `127.0.0.1:8123`, `ollama-api` →
 * `127.0.0.1:11434`); on the single-node home box those are the box's *own*
 * services, not a user-supplied target. Keeping the list explicit (rather
 * than "any loopback") means even a system check can only bypass the guard
 * for a recognised service port — an internal-token check of some other
 * loopback port still goes through the normal private-address rejection.
 */
const KNOWN_LOCAL_SERVICE_PORTS = new Set<number>([
  8123, // Home Assistant
  11434, // Ollama
]);

const LOOPBACK_HOSTS = new Set<string>(['127.0.0.1', '::1', 'localhost']);

/**
 * True when `rawUrl` is a ServiceBay self-check of a known-local hostNetwork
 * service: a loopback host AND a recognised service port (#1670). This — and
 * only this — is what a `systemCheck` is allowed to bypass the guard for.
 * User-supplied internal URLs (arbitrary host/port, RFC1918 LAN hosts) return
 * false here and stay subject to the guard.
 */
export function isKnownLocalSystemTarget(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // URL.hostname keeps the brackets around an IPv6 literal (`[::1]`).
  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!LOOPBACK_HOSTS.has(host) && !host.endsWith('.localhost')) return false;
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  return KNOWN_LOCAL_SERVICE_PORTS.has(port);
}

/**
 * Reject targets that resolve to private/loopback/link-local addresses unless
 * MONITORING_ALLOW_INTERNAL=1 is set. Home-lab deploys typically need to
 * monitor RFC1918 hosts, so the env var lets operators opt in explicitly.
 *
 * `systemCheck` (#1670): a ServiceBay self-created check of a known-local
 * hostNetwork service bypasses the guard — but only when the target itself is
 * a recognised loopback service ({@link isKnownLocalSystemTarget}). The guard
 * exists to stop a *user-supplied* monitoring target from reaching internal
 * hosts; ServiceBay's own self-checks of HA/Ollama on `127.0.0.1` are not
 * that, and shouldn't permanently false-red on a healthy box. A user-supplied
 * internal URL carries no `systemCheck` flag and is still rejected.
 *
 * Throws a descriptive Error on rejection. Returns the resolved IP string
 * (informational only) on accept.
 */
export async function assertHttpTargetAllowed(
  rawUrl: string,
  opts: { systemCheck?: boolean } = {},
): Promise<void> {
  if (process.env.MONITORING_ALLOW_INTERNAL === '1') return;
  if (opts.systemCheck && isKnownLocalSystemTarget(rawUrl)) return;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Disallowed protocol: ${url.protocol}`);
  }

  const host = url.hostname;
  const candidates = await resolveCandidateIps(host);
  for (const ip of candidates) {
    if (isPrivateAddress(ip)) {
      throw new Error(`Internal address blocked: ${host} → ${ip} (set MONITORING_ALLOW_INTERNAL=1 to allow)`);
    }
  }
}

/**
 * Resolve a URL host to the candidate IPs the guard inspects. A literal IP
 * is its own candidate; a `localhost`/`*.localhost` name is rejected
 * outright; any other name is DNS-resolved (all records). Split out of
 * {@link assertHttpTargetAllowed} to keep that function under the complexity
 * budget.
 */
async function resolveCandidateIps(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) {
    throw new Error('Internal hostname blocked (set MONITORING_ALLOW_INTERNAL=1 to allow)');
  }
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.map(a => a.address);
  } catch (e) {
    throw new Error(`DNS lookup failed for ${host}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIpv4(ip);
  if (isIP(ip) === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  return isReservedIpv4Range(a, b);
}

// Octet-range classification split out of isPrivateIpv4 to keep that function
// under the complexity budget. Covers RFC1918 + loopback + "this network" +
// link-local + CGNAT + multicast/reserved.
function isReservedIpv4Range(a: number, b: number): boolean {
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local
  if (lower.startsWith('fe80')) return true; // link-local
  // IPv4-mapped IPv6: ::ffff:a.b.c.d
  const m = lower.match(/^::ffff:([0-9.]+)$/);
  if (m && isIP(m[1]) === 4) return isPrivateIpv4(m[1]);
  return false;
}
