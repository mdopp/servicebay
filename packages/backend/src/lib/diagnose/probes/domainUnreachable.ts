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
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';
import { retryCreate as retryCreateProxyHost } from './proxyRouteMissing';
import { reprovision as reprovisionAdguardRewrites } from './adguardRewritesMissing';

const PROBE_ID = 'domain_unreachable';

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

/**
 * Trust the persisted `exposure` flag when it's there (set by the
 * apex/NPM provisioner since the publicDomain-LAN switch); fall back
 * to the suffix heuristic for older entries.
 */
function entryIsLan(entry: ProxyHostEntry): boolean {
  if (entry.exposure) return entry.exposure === 'lan';
  return isLanDomain(entry.domain);
}

/**
 * `cause` is the discriminator that maps to inline auto-fix actions
 * on the item. The `reason` + `fixHint` strings stay as prose for
 * operators reading; `cause` is the machine-readable hook that
 * decides which fix button shows up on the row.
 *
 * When a cause has no automatic fix today (TLS errors, raw refused,
 * timeouts) we leave it as `'other'` — the row still renders with
 * the prose hint, just no button.
 */
type DiagnosisCause =
  | 'proxy_not_created'           // → retry_create (shared w/ proxy_route_missing)
  | 'adguard_rewrite_missing'      // → reprovision (shared w/ adguard_rewrites_missing)
  | 'adguard_rewrite_drifted'      // → reprovision (same handler; idempotent)
  | 'public_dns_missing'           // → show_public_dns_instructions (new informational)
  | 'lan_ip_not_set'               // → no action yet; #549 (lan_ip_changed) will add reconcile
  | 'tls_failed'                   // → no action; cert_request_failure has the retry
  | 'connection_refused'           // → no action; backend service issue
  | 'timeout'                      // → no action; manual investigation
  | 'npm_route_missing'            // → retry_create (same as proxy_not_created)
  | 'backend_unhealthy'            // → no action; container-log inspection
  | 'redirect_misconfigured'       // → no action; NPM config issue
  | 'other';                       // → no action

interface Diagnosis {
  /** Severity for the per-item row. */
  status: 'warn' | 'fail';
  /** Short, plain-language reason. */
  reason: string;
  /** Where the operator finds the fix; rendered as the row hint. */
  fixHint: string;
  /** Machine-readable failure-class — drives the inline actionIds. */
  cause: DiagnosisCause;
}

/** Map diagnosed cause → action IDs to attach to the item.
 *  Causes not in this map render with prose hint only. */
function actionsForCause(cause: DiagnosisCause): string[] {
  switch (cause) {
    case 'proxy_not_created':
    case 'npm_route_missing':
      return ['retry_create'];
    case 'adguard_rewrite_missing':
    case 'adguard_rewrite_drifted':
      return ['reprovision'];
    case 'public_dns_missing':
      return ['show_public_dns_instructions'];
    default:
      return [];
  }
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

/** Shared return shape between the (currently sole) fetch helper and any
 *  future siblings that classify network errors. fetchOrClassify lived
 *  here previously as a public-DNS counterpart to fetchWithHostHeader;
 *  it was never wired up and got dropped, leaving the type to document
 *  the contract. */
type ClassifiedFetchResult =
  | { ok: true; status: number; bodySnippet: string; headers: Headers }
  | { ok: false; reason: 'tls' | 'refused' | 'timeout' | 'dns' | 'other'; detail: string };

/**
 * Probe NPM directly via the LAN IP with a `Host:` header — the
 * only way to test proxy routing without depending on a working
 * resolver. ServiceBay's container shares the host's network namespace
 * (hostNetwork), so `lanIp:80` is just a TCP socket away.
 */
async function fetchWithHostHeader(npmUrl: string, hostHeader: string): Promise<ClassifiedFetchResult> {
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
  const isLan = entryIsLan(host);
  const scheme = isLan ? 'http' : 'https';

  // 1. Did NPM actually accept the proxy host?
  if (!host.created) {
    return {
      status: 'warn',
      reason: 'Proxy host not confirmed in NPM (install-time creation failed).',
      fixHint: 'Click "Retry create" below — pushes this route into NPM via the same path the install wizard uses. Most common cause if it keeps failing: wrong NPM credentials (see `npm_data_stale`).',
      cause: 'proxy_not_created',
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
        fixHint: 'Click "Reprovision AdGuard rewrites" below — re-runs the install-time provisioner (idempotent, only touches missing entries).',
        cause: 'adguard_rewrite_missing',
      };
    }
    if (lanIp && !rewriteAnswers.includes(lanIp)) {
      return {
        status: 'fail',
        reason: `AdGuard rewrite points at ${rewriteAnswers.join(', ')} but ServiceBay's LAN IP is ${lanIp} (drifted since install?).`,
        fixHint: 'Click "Reprovision AdGuard rewrites" below — refreshes the rewrite to the current LAN IP.',
        cause: 'adguard_rewrite_drifted',
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
        fixHint: 'Click "Show DNS instructions" below for the exact A-record you need to add at your registrar.',
        cause: 'public_dns_missing',
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
      fixHint: 'Trigger a LAN-IP reconcile by restarting ServiceBay, or set it explicitly via Settings → Reverse Proxy. The `lan_ip_changed` probe will get a dedicated reconcile action in a future release.',
      cause: 'lan_ip_not_set',
    };
  }
  const probe = await fetchWithHostHeader(`http://${lanIp}:80/`, domain);
  if (!probe.ok) {
    if (probe.reason === 'refused') {
      return {
        status: 'fail',
        reason: `Connection refused on ${scheme}://${domain} — NPM running, but no backend answering port ${host.forwardPort}.`,
        fixHint: `Check that the \`${host.service}\` service is running. If it is, the proxy host's forward_port may not match the container's listen port.`,
        cause: 'connection_refused',
      };
    }
    if (probe.reason === 'tls') {
      return {
        status: 'fail',
        reason: `TLS handshake failed: ${probe.detail.slice(0, 160)}`,
        fixHint: 'See `cert_request_failure` → Retry now. If Let\'s Encrypt rate-limited you, wait ~1 h and check that public port 80 is reachable.',
        cause: 'tls_failed',
      };
    }
    if (probe.reason === 'timeout') {
      return {
        status: 'fail',
        reason: 'Request timed out before NPM responded.',
        fixHint: 'NPM may be down or the backend is hanging. Restart the nginx service from Services, or check container logs.',
        cause: 'timeout',
      };
    }
    return {
      status: 'fail',
      reason: `Reachability check failed: ${probe.detail.slice(0, 160)}`,
      fixHint: 'Check NPM and the backing service\'s container logs.',
      cause: 'other',
    };
  }

  // 5. We got a response. Is it NPM's default page (proxy host
  //    not configured for this `Host:` header)?
  if (probe.status === 404 || probe.status === 503) {
    if (probe.bodySnippet.includes('Congratulations') || probe.bodySnippet.includes('nginx-proxy-manager')) {
      return {
        status: 'fail',
        reason: `NPM has no proxy host matching Host: ${domain} — the route isn't actually configured even though the config says created=true.`,
        fixHint: 'Click "Retry create" below to push the route into NPM.',
        cause: 'npm_route_missing',
      };
    }
    return {
      status: 'warn',
      reason: `Backend returned HTTP ${probe.status}.`,
      fixHint: `'${host.service}' is reachable through NPM but the upstream is unhealthy. Check its container logs.`,
      cause: 'backend_unhealthy',
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
      cause: 'redirect_misconfigured',
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
    actionIds: actionsForCause(diagnosis.cause),
  }));

  const parts: string[] = [];
  if (failCount) parts.push(`${failCount} unreachable`);
  if (warnCount) parts.push(`${warnCount} degraded`);

  return {
    status: overall,
    detail: `${parts.join(' · ')} of ${hosts.length} configured domain${hosts.length === 1 ? '' : 's'}.`,
    hint: 'Each row shows what went wrong. When the failure has a known auto-fix, the row has a button — click it. When the fix is genuinely manual (DNS A-records, TLS rate limits), the row carries the instructions inline.',
    items,
  };
}

// ─── Action handlers ────────────────────────────────────────────────────
//
// Two handlers are *re-exports* of the same logic registered on sibling
// probes. We mount them here too so the operator gets the fix button on
// the offending domain row directly — no probe-to-probe navigation.

/** Render an instructions block for the public A-record case.
 *
 *  We deliberately don't try to look up the operator's WAN IP from
 *  here — `dns_routing` health checks already track it and the
 *  diagnose page can cross-reference. Instructions name the apex
 *  the operator already configured (`config.publicDomain`) and tell
 *  them the exact record to add. */
async function showPublicDnsInstructions({ itemId }: { itemId?: string }): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No domain supplied.', refresh: false };
  }
  const config = await getConfig();
  const apex = config.reverseProxy?.publicDomain || itemId.replace(/^[^.]+\./, '') || '<your apex>';
  const lines = [
    `Public DNS isn't resolving \`${itemId}\` yet. Add this record at your DNS provider:`,
    '',
    `  Type:  A`,
    `  Host:  *.${apex}     (wildcard — covers every subdomain)`,
    `  Value: <your WAN IP>     (find it at https://api.ipify.org or any "what's my IP" service)`,
    `  TTL:   300              (5 min — faster propagation if you need to change it)`,
    '',
    `If you'd rather pin each subdomain explicitly, add an A record for \`${itemId}\` only,`,
    `same Value + TTL. The wildcard form is simpler and survives adding new services later.`,
    '',
    `On a dynamic public IP, see your registrar's DDNS docs (Cloudflare, MyFRITZ!, DuckDNS, etc.) —`,
    `the FritzBox can update DDNS automatically under Internet → Freigaben → DynDNS.`,
    '',
    `After the record propagates (~5 min), re-run this diagnose probe — the row should clear.`,
  ];
  return {
    ok: true,
    message: 'Instructions ready below.',
    details: lines.join('\n'),
    refresh: false,
  };
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'retry_create',
    label: 'Retry create',
    description:
      'Pushes this proxy host into Nginx Proxy Manager. Same handler as the `proxy_route_missing` probe — registered here so the fix button is on the domain row directly, no probe navigation.',
  },
  retryCreateProxyHost,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'reprovision',
    label: 'Reprovision AdGuard rewrites',
    description:
      'Re-runs the install-time portal provisioner so AdGuard\'s rewrite for this domain points at ServiceBay\'s current LAN IP. Idempotent — existing rewrites with the right answer are left alone. Same handler as the `adguard_rewrites_missing` probe.',
  },
  reprovisionAdguardRewrites,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'show_public_dns_instructions',
    label: 'Show DNS instructions',
    description:
      'Renders the exact A-record to add at your DNS registrar to make this public domain resolvable. Informational only — public DNS configuration is manual by nature.',
  },
  showPublicDnsInstructions,
);

logger.debug(
  'diagnose:probes',
  `Registered ${PROBE_ID} actions: retry_create, reprovision, show_public_dns_instructions`,
);
