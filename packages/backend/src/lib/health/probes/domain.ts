/**
 * `domain` probe — the single canonical per-domain health check (#1564).
 *
 * One `domain:<domain>` check per reverse-proxy host now subsumes BOTH
 * concerns that used to be two separate rows:
 *
 *   1. **NPM routing** (every domain): talks to local NPM with a `Host:`
 *      header rather than resolving the name, so RFC 8375 `.home.arpa`
 *      zones work from inside ServiceBay's container even when its own
 *      resolver doesn't know about them. No SSRF guard — hitting our own
 *      LAN IP is the point.
 *   2. **DNS routing** (public domains only): the DoH-based "does public
 *      DNS still point at me?" check that previously lived in its own
 *      `dns_routing:<domain>` row. Resolved via `resolveDnsRouting`; its
 *      structured payload rides this check's result so the diagnose
 *      `domain_unreachable` reader picks it up unchanged.
 *
 * Result status is the worst of the two layers. The dns_routing payload
 * (when public) is attached to `payload` so consumers can decode it.
 */

import { registerProbe } from './registry';
import { getConfig } from '../../config';
import { resolveDnsRouting, type DnsRoutingPayload } from './dnsRouting';

async function checkNpmRouting(lanIp: string, target: string, expectedScheme?: string) {
  const url = `http://${lanIp}:80/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { Host: target },
    });

    if (res.status === 404 || res.status === 503) {
      const body = await res.text().catch(() => '');
      if (body.includes('Congratulations') || body.includes('nginx-proxy-manager')) {
        throw new Error(`Proxy host for ${target} not configured in NPM`);
      }
    }

    if (expectedScheme === 'https' && (res.status === 301 || res.status === 302)) {
      const loc = res.headers.get('location') || '';
      if (loc.startsWith('https://')) return `routed via NPM, ssl_forced redirect to ${loc}`;
      return `routed via NPM, redirect ${res.status} to ${loc || '(empty)'}`;
    }

    if (res.status >= 200 && res.status < 400) {
      return `routed via NPM, HTTP ${res.status}`;
    }
    throw new Error(`NPM returned HTTP ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** One-line DNS-routing summary for the combined `domain` message. */
function summariseDns(dns: { status: 'ok' | 'fail'; payload?: DnsRoutingPayload; message?: string }): string {
  if (!dns.payload) return `DNS: ${dns.message ?? 'lookup failed'}`;
  const { expected, resolved, matched } = dns.payload;
  if (expected === null) return `DNS resolves to ${resolved.join(', ') || '(no A record)'} (public IP not yet known)`;
  if (resolved.length === 0) return 'DNS: no public A record';
  if (matched) return `DNS → ${expected} (matches gateway)`;
  return `DNS → ${resolved.join(', ')} (expected ${expected})`;
}

registerProbe({
  type: 'domain',
  async run(check) {
    const cfg = check.domainConfig;
    if (!cfg) throw new Error('domainConfig missing');
    const config = await getConfig();
    const lanIp = config.reverseProxy?.lanIp;
    if (!lanIp) throw new Error('reverseProxy.lanIp not configured — cannot probe NPM');

    const npmMessage = await checkNpmRouting(lanIp, check.target, cfg.expectedScheme);

    // LAN-only domains have no public DNS to route — NPM routing is the
    // whole story, no payload to attach.
    if (!cfg.isPublic) return { status: 'ok' as const, message: npmMessage };

    // Public domain: fold in the DoH DNS-routing layer. The probe row
    // fails if DNS doesn't point at us even when NPM routing is healthy.
    const dns = await resolveDnsRouting(check.target);
    const message = `${npmMessage} · ${summariseDns(dns)}`;
    return {
      status: dns.status,
      message,
      ...(dns.payload ? { payload: dns.payload } : {}),
    };
  },
});
