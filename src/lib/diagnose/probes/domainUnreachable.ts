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
import { getConfig, type ProxyHostEntry, type AppConfig } from '@/lib/config';
import { logger } from '@/lib/logger';
import { listRewrites } from '@/lib/adguard/rewrites';
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

/**
 * "Is DNS configured for this LAN domain?" — answered by asking
 * AdGuard, not by trying to resolve the name. ServiceBay's container
 * doesn't use AdGuard as its own resolver, so `dns.lookup` against
 * a `.home.arpa` name always fails regardless of how clean the
 * AdGuard rewrite list looks. Clients using AdGuard as DNS get the
 * right answer; the diagnose probe needs to verify that, not
 * mistakenly conflate it with its own resolver setup.
 *
 * Returns `null` when AdGuard credentials aren't stored yet — the
 * caller treats that as "AdGuard not deployed", which is the same
 * answer as "no rewrite found".
 */
async function adguardResolves(domain: string, config: AppConfig): Promise<string[] | null> {
  const ag = config.adguard;
  if (!ag?.password) return null;
  try {
    const rewrites = await listRewrites({
      adminUrl: ag.adminUrl || `http://localhost:${config.templateSettings?.ADGUARD_ADMIN_PORT ?? '8083'}`,
      username: ag.username || 'admin',
      password: ag.password,
    });
    // AdGuard wildcard entries store as `*.home.arpa`. Match either
    // a literal entry OR a wildcard whose suffix covers the domain.
    const matches = rewrites
      .filter(r => r.domain === domain || (r.domain.startsWith('*.') && domain.endsWith(r.domain.slice(1))))
      .map(r => r.answer);
    return matches.length > 0 ? Array.from(new Set(matches)) : null;
  } catch {
    return null;
  }
}

async function fetchOrClassify(url: string): Promise<{ ok: true; status: number; bodySnippet: string; headers: Headers } | { ok: false; reason: 'tls' | 'refused' | 'timeout' | 'dns' | 'other'; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const body = await res.text().catch(() => '');
    return { ok: true, status: res.status, bodySnippet: body.slice(0, 256), headers: res.headers };
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

/**
 * Probe NPM directly via the LAN IP with a `Host:` header — the
 * only way to test proxy routing without depending on a working
 * resolver. Same shape as `fetchOrClassify`. ServiceBay's container
 * shares the host's network namespace (hostNetwork), so `lanIp:80`
 * is just a TCP socket away.
 */
async function fetchWithHostHeader(npmUrl: string, hostHeader: string): Promise<ReturnType<typeof fetchOrClassify> extends Promise<infer T> ? T : never> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(npmUrl, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { Host: hostHeader },
    });
    const body = await res.text().catch(() => '');
    return { ok: true, status: res.status, bodySnippet: body.slice(0, 256), headers: res.headers };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/ECONNREFUSED/i.test(msg)) return { ok: false, reason: 'refused', detail: msg };
    if (/aborted|timeout|ETIMEDOUT/i.test(msg)) return { ok: false, reason: 'timeout', detail: msg };
    if (/certificate|TLS|SSL|self-signed|unable to verify/i.test(msg)) return { ok: false, reason: 'tls', detail: msg };
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return { ok: false, reason: 'dns', detail: msg };
    return { ok: false, reason: 'other', detail: msg };
  } finally {
    clearTimeout(timeout);
  }
}

async function diagnoseDomain(host: ProxyHostEntry, config: AppConfig): Promise<Diagnosis | null> {
  const domain = host.domain;
  const lanIp = config.reverseProxy?.lanIp;
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

  // 2. DNS configuration check. Two different mechanisms by domain
  //    class — ServiceBay's container resolver doesn't use AdGuard,
  //    so asking it about `.home.arpa` will always fail regardless
  //    of whether the rewrites are correct. Talk to AdGuard
  //    directly instead.
  if (isLan) {
    const rewriteAnswers = await adguardResolves(domain, config);
    if (!rewriteAnswers) {
      return {
        status: 'fail',
        reason: 'No matching AdGuard rewrite for this domain — LAN clients can\'t resolve it.',
        fixHint: 'See `adguard_rewrites_missing` → Reprovision.',
      };
    }
    if (lanIp && !rewriteAnswers.includes(lanIp)) {
      return {
        status: 'fail',
        reason: `AdGuard rewrite points at ${rewriteAnswers.join(', ')} but ServiceBay's LAN IP is ${lanIp} (drifted since install?).`,
        fixHint: 'See `adguard_rewrites_missing` → Reprovision (refreshes the rewrite to the current LAN IP).',
      };
    }
  } else {
    // Public domain — verify the public resolver returns at least one
    // address. If it doesn't, the A-record is missing entirely.
    const ips = await resolveOrNull(domain);
    if (!ips || ips.length === 0) {
      return {
        status: 'fail',
        reason: 'Hostname does not resolve via public DNS. A-record likely missing.',
        fixHint: 'Add an A-record at your DNS provider pointing the apex/wildcard at your WAN IP. See `router_dns_not_pointing` for the LAN side of the same trio.',
      };
    }
  }

  // 3. Routing test — talk to NPM directly on the LAN IP with
  //    a Host: header. Doesn't depend on resolver config so it
  //    works for both internal and public domains regardless of
  //    whether the operator's devices have been pointed at AdGuard
  //    yet. NPM's ssl_forced redirect surfaces as 301 → https://.
  if (!lanIp) {
    return {
      status: 'warn',
      reason: 'reverseProxy.lanIp not set; cannot probe NPM routing.',
      fixHint: 'Trigger a LAN-IP reconcile by restarting ServiceBay, or set it explicitly via Settings → Reverse Proxy.',
    };
  }
  const probe = await fetchWithHostHeader(`http://${lanIp}:80/`, domain);
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

  // 5. We got a response. Is it NPM's default page (proxy host
  //    not configured for this `Host:` header)?
  if (probe.status === 404 || probe.status === 503) {
    if (probe.bodySnippet.includes('Congratulations') || probe.bodySnippet.includes('nginx-proxy-manager')) {
      return {
        status: 'fail',
        reason: `NPM has no proxy host matching Host: ${domain} — the route isn't actually configured even though the config says created=true.`,
        fixHint: 'See `proxy_route_missing` → Retry create.',
      };
    }
    return {
      status: 'warn',
      reason: `Backend returned HTTP ${probe.status}.`,
      fixHint: `'${host.service}' is reachable through NPM but the upstream is unhealthy. Check its container logs.`,
    };
  }

  // 6. For ssl_forced public hosts NPM responds 301 → https://. That
  //    proves the vhost + cert binding are in place. A 301 to anything
  //    else means the route is half-configured.
  if (!isLan && (probe.status === 301 || probe.status === 302)) {
    const loc = probe.headers.get('location') || '';
    if (loc.startsWith(`https://${domain}`)) {
      return null; // healthy
    }
    return {
      status: 'warn',
      reason: `NPM redirected ${probe.status} → ${loc || '(empty Location)'}; expected https://${domain}/.`,
      fixHint: 'The NPM host for this domain may have ssl_forced toggled off, or the cert isn\'t bound. See `cert_request_failure`.',
    };
  }

  // 7. 2xx / 3xx for LAN, anything else → healthy. Continuous
  //    `domain` health-check dot covers per-minute monitoring; this
  //    probe is only here to *explain* the broken ones.
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

  const settled = await Promise.all(
    hosts.map(async h => {
      try {
        const d = await diagnoseDomain(h, config);
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
