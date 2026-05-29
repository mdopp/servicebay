import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Reject targets that resolve to private/loopback/link-local addresses unless
 * MONITORING_ALLOW_INTERNAL=1 is set. Home-lab deploys typically need to
 * monitor RFC1918 hosts, so the env var lets operators opt in explicitly.
 *
 * Throws a descriptive Error on rejection. Returns the resolved IP string
 * (informational only) on accept.
 */
export async function assertHttpTargetAllowed(rawUrl: string): Promise<void> {
  if (process.env.MONITORING_ALLOW_INTERNAL === '1') return;

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
  const candidates: string[] = [];
  if (isIP(host)) {
    candidates.push(host);
  } else {
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost')) {
      throw new Error('Internal hostname blocked (set MONITORING_ALLOW_INTERNAL=1 to allow)');
    }
    try {
      const addrs = await lookup(host, { all: true });
      for (const a of addrs) candidates.push(a.address);
    } catch (e) {
      throw new Error(`DNS lookup failed for ${host}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const ip of candidates) {
    if (isPrivateAddress(ip)) {
      throw new Error(`Internal address blocked: ${host} → ${ip} (set MONITORING_ALLOW_INTERNAL=1 to allow)`);
    }
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
