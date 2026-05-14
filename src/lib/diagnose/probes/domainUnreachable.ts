/**
 * `domain_unreachable` probe — walks every NPM proxy host in config
 * and classifies *why* it isn't reachable (when it isn't). The
 * companion to the continuous `domain` health check: that one says
 * "reachable yes/no" with a one-line message; this one digs in and
 * tells the operator which layer broke and where the fix lives.
 *
 * Layered diagnosis per domain:
 *
 *   1. **Persistence** — is the host marked `created: true` in
 *      `config.reverseProxy.hosts`? If not, NPM never confirmed it,
 *      and the existing `proxy_route_missing` probe has the
 *      "Retry create" action.
 *
 *   2. **DNS resolution** — does the hostname resolve from this
 *      server's resolver? Internal domains rely on AdGuard rewrites;
 *      missing rewrites fall under `adguard_rewrites_missing`.
 *      Public domains rely on real DNS + (often) router hairpin.
 *
 *   3. **Reachability** — can we HTTP(S) GET `/`? Distinguishes:
 *        - Connection refused → service on `upstreamPort` not
 *          listening (restart the backing service).
 *        - TLS error → expired/missing cert; `cert_request_failure`
 *          has the LE retry path.
 *        - NPM default page → proxy host exists but isn't wired
 *          to a backend (port mismatch / service stopped).
 *        - Generic non-2xx/3xx → backend reachable but unhealthy.
 *
 * Output: one ProbeItem per problematic domain with a short
 * diagnosis + a hint pointing at the matching fix probe. Healthy
 * domains aren't listed (the dot in /services + /network shows
 * status at-a-glance; this probe focuses attention on the broken
 * ones).
 *
 * Lightweight by design — we only do native `fetch` here; the
 * heavyweight internet-side reachability check stays in
 * `domain_external_reachability` (letsdebug).
 */

import dns from 'dns/promises';
import { getConfig, type ProxyHostEntry } from '@/lib/config';
import { logger } from '@/lib/logger';
import type { ProbeItem } from '../actions';

export interface DomainUnreachableResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

const FETCH_TIMEOUT_MS = 6000;
const DNS_TIMEOUT_MS = 3000;

function isLanDomain(domain: string): boolean {
  return domain.endsWith('.home.arpa') || domain.endsWith('.local');
}

interface Diagnosis {
  /** Severity for the per-item row. */
  status: 'warn' | 'fail';
  /** Short, plain-language reason. */
  reason: string;
  /** Where the operator finds the fix; rendered as the row hint. */
  fixHint: string;
}

async function resolveOrNull(hostname: string): Promise<string[] | null> {
  try {
    const records = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), DNS_TIMEOUT_MS)),
    ]);
    return records.map(r => r.address);
  } catch {
    return null;
  }
}

async function fetchOrClassify(url: string): Promise<{ ok: true; status: number; bodySnippet: string } | { ok: false; reason: 'tls' | 'refused' | 'timeout' | 'dns' | 'other'; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const body = await res.text().catch(() => '');
    return { ok: true, status: res.status, bodySnippet: body.slice(0, 256) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return { ok: false, reason: 'dns', detail: msg };
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, reason: 'refused', detail: msg };
    if (/aborted|timeout|ETIMEDOUT/i.test(msg)) return { ok: false, reason: 'timeout', detail: msg };
    if (/certificate|TLS|SSL|self-signed|unable to verify/i.test(msg)) return { ok: false, reason: 'tls', detail: msg };
    return { ok: false, reason: 'other', detail: msg };
  } finally {
    clearTimeout(timeout);
  }
}

async function diagnoseDomain(host: ProxyHostEntry, lanIp: string | undefined): Promise<Diagnosis | null> {
  const domain = host.domain;
  const isLan = isLanDomain(domain);
  const scheme = isLan ? 'http' : 'https';

  // 1. Did NPM actually accept the proxy host?
  if (!host.created) {
    return {
      status: 'warn',
      reason: 'Proxy host not confirmed in NPM (install-time creation failed).',
      fixHint: 'See `proxy_route_missing` → Retry create. Most common cause: wrong NPM credentials (see `npm_data_stale`).',
    };
  }

  // 2. Does the hostname resolve at all?
  const ips = await resolveOrNull(domain);
  if (!ips || ips.length === 0) {
    return {
      status: 'fail',
      reason: isLan
        ? 'Hostname does not resolve. AdGuard DNS rewrites probably missing.'
        : 'Hostname does not resolve. Public DNS A-record likely absent or pointing at the wrong IP.',
      fixHint: isLan
        ? 'See `adguard_rewrites_missing` → Reprovision.'
        : 'Add an A-record at your DNS provider pointing the apex/wildcard at your WAN IP. See `router_dns_not_pointing` for the LAN side of the same trio.',
    };
  }

  // 3. For LAN domains, the IP must be ServiceBay's LAN IP. Anything
  //    else means a stale AdGuard rewrite (drifted lanIp).
  if (isLan && lanIp && !ips.includes(lanIp)) {
    return {
      status: 'fail',
      reason: `Resolves to ${ips.join(', ')} but ServiceBay's LAN IP is ${lanIp}.`,
      fixHint: 'See `adguard_rewrites_missing` → Reprovision (updates the rewrite to the current LAN IP).',
    };
  }

  // 4. Actually try to reach it.
  const url = `${scheme}://${domain}/`;
  const probe = await fetchOrClassify(url);
  if (!probe.ok) {
    if (probe.reason === 'refused') {
      return {
        status: 'fail',
        reason: `Connection refused on ${scheme}://${domain} — NPM running, but no backend answering port ${host.forwardPort}.`,
        fixHint: 'Check that the `${host.service}` service is running. If it is, the proxy host\'s forward_port may not match the container\'s listen port.'.replace('${host.service}', host.service),
      };
    }
    if (probe.reason === 'tls') {
      return {
        status: 'fail',
        reason: `TLS handshake failed: ${probe.detail.slice(0, 160)}`,
        fixHint: 'See `cert_request_failure` → Retry now. If Let\'s Encrypt rate-limited you, wait ~1 h and check that public port 80 is reachable.',
      };
    }
    if (probe.reason === 'timeout') {
      return {
        status: 'fail',
        reason: 'Request timed out before NPM responded.',
        fixHint: 'NPM may be down or the backend is hanging. Restart the nginx service from Services, or check container logs.',
      };
    }
    return {
      status: 'fail',
      reason: `Reachability check failed: ${probe.detail.slice(0, 160)}`,
      fixHint: 'Check NPM and the backing service\'s container logs.',
    };
  }

  // 5. We got a response. Is it NPM's default "this is the proxy"
  //    page (meaning the host record exists but no real route)?
  if (probe.status === 404 || probe.status === 503) {
    if (probe.bodySnippet.includes('Congratulations') || probe.bodySnippet.includes('nginx-proxy-manager')) {
      return {
        status: 'fail',
        reason: `Reached NPM's default page — proxy host configured but not routed to a backend on port ${host.forwardPort}.`,
        fixHint: `Verify the proxy host's forward_port (${host.forwardPort}) matches what '${host.service}' actually listens on. If the service moved ports, re-run the template's deploy.`,
      };
    }
    return {
      status: 'warn',
      reason: `Backend returned HTTP ${probe.status}.`,
      fixHint: `'${host.service}' is reachable but unhealthy. Check its container logs.`,
    };
  }

  // 6. 2xx / 3xx — call it healthy. (The continuous `domain` health
  //    check already covers per-second monitoring; this probe is
  //    only for "tell me why it broke".)
  return null;
}

export async function checkDomainUnreachable(): Promise<DomainUnreachableResult> {
  const config = await getConfig();
  const hosts = config.reverseProxy?.hosts ?? [];
  if (hosts.length === 0) {
    return {
      status: 'info',
      detail: 'No proxy hosts configured — nothing to diagnose.',
    };
  }

  const lanIp = config.reverseProxy?.lanIp;
  const settled = await Promise.all(
    hosts.map(async h => {
      try {
        const d = await diagnoseDomain(h, lanIp);
        return { host: h, diagnosis: d };
      } catch (e) {
        logger.warn('diagnose:domain_unreachable', `Probe for ${h.domain} threw: ${e instanceof Error ? e.message : String(e)}`);
        return { host: h, diagnosis: null };
      }
    }),
  );

  const broken = settled.filter(r => r.diagnosis !== null) as Array<{ host: ProxyHostEntry; diagnosis: Diagnosis }>;
  if (broken.length === 0) {
    return {
      status: 'ok',
      detail: `All ${hosts.length} domain${hosts.length === 1 ? '' : 's'} reachable.`,
    };
  }

  const failCount = broken.filter(b => b.diagnosis.status === 'fail').length;
  const warnCount = broken.length - failCount;
  const overall: 'warn' | 'fail' = failCount > 0 ? 'fail' : 'warn';

  const items: ProbeItem[] = broken.map(({ host, diagnosis }) => ({
    id: host.domain,
    label: host.domain,
    detail: `${diagnosis.reason}  ·  Fix: ${diagnosis.fixHint}`,
    status: diagnosis.status,
    actionIds: [],
  }));

  const parts: string[] = [];
  if (failCount) parts.push(`${failCount} unreachable`);
  if (warnCount) parts.push(`${warnCount} degraded`);

  return {
    status: overall,
    detail: `${parts.join(' · ')} of ${hosts.length} configured domain${hosts.length === 1 ? '' : 's'}.`,
    hint: 'Each row shows what went wrong and which other probe carries the fix action.',
    items,
  };
}
