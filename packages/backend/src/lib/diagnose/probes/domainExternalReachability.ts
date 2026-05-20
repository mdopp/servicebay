/**
 * `domain_external_reachability` probe — surfaces the external view
 * of every public-exposure domain. Composed of two layers:
 *
 *   1. **Continuous: DoH-based DNS routing** (the `dns_routing` health
 *      check). Cheap, free, no third-party rate limits — answers
 *      "does public DNS resolve this domain to my known public IP?"
 *      every 15 min via Cloudflare 1.1.1.1.
 *   2. **On-demand: letsdebug.net** (`run_letsdebug` action below).
 *      The full taxonomy — CAA records, port-80 HTTP-01 simulation,
 *      DNSSEC drift, ACME readiness — for when DNS looks right but
 *      something else is wrong. The operator clicks the button per
 *      domain; results are saved as a transient `letsdebug:<domain>`
 *      result so the row reads "letsdebug last ran X ago".
 *
 * History: the probe used to drive a continuous `letsdebug:<domain>`
 * check on a 4 h timer. letsdebug rate-limits by source IP and most
 * household NAT pools share traffic with other servicebay instances,
 * so the 4 h sweep 429'd in practice. This rewrite moves continuous
 * monitoring onto DoH and keeps letsdebug as the deep-diagnostic
 * affordance.
 */

import { getConfig } from '@/lib/config';
import {
  registerProbeAction,
  type ProbeActionResult,
  type ProbeItem,
} from '../actions';
import { HealthStore } from '@/lib/health/store';
import { CheckRunner } from '@/lib/health/runner';
import {
  DNS_ROUTING_MESSAGE_PREFIX,
  LETSDEBUG_MESSAGE_PREFIX,
} from '@/lib/health/runner';
import type { CheckResult } from '@/lib/health/types';
import { runLetsdebugForDomain, type LetsdebugProblem } from '@/lib/letsdebug/client';
import { logger } from '@/lib/logger';

const PROBE_ID = 'domain_external_reachability';
const DNS_ROUTING_CHECK_PREFIX = 'dns_routing:';
const LETSDEBUG_CHECK_PREFIX = 'letsdebug:';

export interface DomainExternalReachabilityResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

function isPublicEntry(entry: { domain: string; exposure?: 'public' | 'internal' | 'lan' }): boolean {
  // Only `public` should be probed for external reachability — `internal`
  // hosts have a public DNS record (so LE can validate) but are firewalled
  // to the LAN by NPM, so probing from a public DNS-over-HTTPS resolver
  // returns false-positives ("LAN IP, looks broken").
  if (entry.exposure) return entry.exposure === 'public';
  if (!entry.domain) return false;
  return !entry.domain.endsWith('.home.arpa') && !entry.domain.endsWith('.local');
}

/**
 * Compact "X ago" string for the operator-facing "last checked"
 * suffix. Bins coarsen as age grows — minutes <1h, hours <24h, days
 * after. Rounds down so a probe that just landed reads "just now".
 */
function formatRelativeAge(fetchedAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 30)                  return 'just now';
  if (seconds < 60)                  return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)                  return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)                    return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

interface DnsRoutingPayload {
  expected: string | null;
  resolved: string[];
  matched: boolean;
}

function decodeDnsRouting(message: string | undefined): DnsRoutingPayload | null {
  if (!message || !message.startsWith(DNS_ROUTING_MESSAGE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(message.slice(DNS_ROUTING_MESSAGE_PREFIX.length));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      expected: typeof parsed.expected === 'string' ? parsed.expected : null,
      resolved: Array.isArray(parsed.resolved) ? parsed.resolved.filter((s: unknown) => typeof s === 'string') : [],
      matched: !!parsed.matched,
    };
  } catch {
    return null;
  }
}

interface LetsdebugPayload {
  problems: LetsdebugProblem[];
  submissionUrl: string | null;
}

function decodeLetsdebug(message: string | undefined): LetsdebugPayload | null {
  if (!message || !message.startsWith(LETSDEBUG_MESSAGE_PREFIX)) return null;
  try {
    const json = message.slice(LETSDEBUG_MESSAGE_PREFIX.length);
    const parsed = JSON.parse(json);
    if (!parsed || !Array.isArray(parsed.problems)) return null;
    return {
      problems: parsed.problems as LetsdebugProblem[],
      submissionUrl: typeof parsed.submissionUrl === 'string' ? parsed.submissionUrl : null,
    };
  } catch {
    return null;
  }
}

async function listPublicDomains(): Promise<string[]> {
  const config = await getConfig();
  const hosts = config.reverseProxy?.hosts ?? [];
  return Array.from(new Set(hosts.filter(isPublicEntry).map(h => h.domain)));
}

async function getPublicDomainSuffix(): Promise<string | null> {
  const config = await getConfig();
  return config.reverseProxy?.publicDomain ?? null;
}

function worst(a: 'ok' | 'warn' | 'fail', b: 'ok' | 'warn' | 'fail'): 'ok' | 'warn' | 'fail' {
  if (a === 'fail' || b === 'fail') return 'fail';
  if (a === 'warn' || b === 'warn') return 'warn';
  return 'ok';
}

/** Outcome of one HTTP-status check (#611). */
interface HttpStatusResult {
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

/**
 * HTTP-status check for a single public domain (#611).
 *
 * Probes `https://<domain>/` from inside the ServiceBay container.
 * Caught the v4.0.x outage where every proxied service was 502-ing
 * because Authelia was crash-looping but DNS still resolved fine.
 *
 * Classification:
 *   - 2xx → ok
 *   - 302/303/307/308 → ok if Location points at `auth.<publicDomain>`
 *     (Authelia forward-auth redirect for unauthenticated visitors).
 *     Other redirects → warn.
 *   - 401 / 403 → ok (auth-gated endpoint serving an unauthenticated
 *     request; the proxy is healthy, the app just wants creds).
 *   - 5xx → fail with the status code in the detail.
 *   - 4xx other than 401/403 → warn (some apps 404 on `/` by design,
 *     which is normal — don't fail-fast on it).
 *   - Network error / timeout → fail.
 *
 * Internal probe by design — runs from inside the container, hits the
 * local NPM. Cheap, no third-party dep, no rate limits. Catches "NPM
 * up + backend down" which is the failure mode #611 was filed for.
 * The DNS layer (Cloudflare DoH) and letsdebug already cover the
 * external-reachability question for cases where the upstream firewall
 * itself is the problem.
 */
export async function probeHttpStatus(
  domain: string,
  publicDomain: string | null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<HttpStatusResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://${domain}/`, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'Accept': 'text/html,*/*' },
      signal: controller.signal,
    });
    const code = res.status;
    if (code >= 200 && code < 300) return { status: 'ok', detail: `HTTP ${code}` };
    if (code >= 300 && code < 400) {
      const location = res.headers.get('location') || '';
      const authHost = publicDomain ? `auth.${publicDomain}` : null;
      if (authHost && location.includes(authHost)) {
        return { status: 'ok', detail: `HTTP ${code} → ${authHost} (forward-auth)` };
      }
      return { status: 'warn', detail: `HTTP ${code} → ${location || 'no Location header'}` };
    }
    if (code === 401 || code === 403) {
      return { status: 'ok', detail: `HTTP ${code} (auth-gated, proxy healthy)` };
    }
    if (code >= 500) return { status: 'fail', detail: `HTTP ${code}` };
    // 400, 404, 405, 410, etc. — common on apps that don't serve `/`.
    return { status: 'warn', detail: `HTTP ${code}` };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return {
      status: 'fail',
      detail: aborted ? `timeout after ${timeoutMs}ms` : (e instanceof Error ? e.message : String(e)),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkDomainExternalReachability(): Promise<DomainExternalReachabilityResult> {
  const publicDomains = await listPublicDomains();
  if (publicDomains.length === 0) {
    return {
      status: 'ok',
      detail: 'No public domains configured — external reachability check skipped.',
    };
  }

  // #611 — also issue an internal HTTPS GET per domain to catch the
  // "DNS green but upstream returning 5xx" class that v4.0.x had
  // silently. Run in parallel so the probe round-trip stays roughly
  // the same wall-time as the existing DNS-only path.
  const publicDomainSuffix = await getPublicDomainSuffix();
  const httpResults: Map<string, HttpStatusResult> = new Map();
  await Promise.all(publicDomains.map(async domain => {
    httpResults.set(domain, await probeHttpStatus(domain, publicDomainSuffix));
  }));

  let overall: 'ok' | 'warn' | 'fail' = 'ok';
  const items: ProbeItem[] = [];
  let failedCount = 0;
  let warnCount = 0;
  let pendingCount = 0;

  for (const domain of publicDomains) {
    const dnsResult: CheckResult | null = HealthStore.getLastResult(`${DNS_ROUTING_CHECK_PREFIX}${domain}`);
    const letsdebugResult: CheckResult | null = HealthStore.getLastResult(`${LETSDEBUG_CHECK_PREFIX}${domain}`);

    // First-check pending — the dns_routing tick hasn't fired yet.
    if (!dnsResult) {
      pendingCount++;
      items.push({
        id: domain,
        label: domain,
        detail: '⏳ First check pending — runs within ~15 min of boot. Click Refresh now to skip the wait.',
        status: 'info',
        actionIds: ['refresh_now', 'run_letsdebug'],
      });
      continue;
    }

    const dnsAge = ` · Last checked ${formatRelativeAge(Date.parse(dnsResult.timestamp))}`;
    const dnsPayload = decodeDnsRouting(dnsResult.message);

    // dns_routing transport error → plaintext message, no payload. Surface as info row.
    if (!dnsPayload && dnsResult.status === 'fail') {
      pendingCount++;
      items.push({
        id: domain,
        label: domain,
        detail: `DNS check could not run (${(dnsResult.message ?? 'unknown error').slice(0, 120)})${dnsAge}`,
        status: 'info',
        actionIds: ['refresh_now', 'run_letsdebug'],
      });
      continue;
    }

    // No payload + ok status → unknown public IP, nothing useful to compare.
    if (!dnsPayload) continue;

    // Compose the per-row narrative.
    let rowStatus: 'ok' | 'warn' | 'fail';
    let rowDetail: string;

    if (dnsPayload.expected === null) {
      // gateway.publicIp not known yet — say what we resolved, don't shout.
      rowStatus = 'ok';
      rowDetail = `Resolves externally to ${dnsPayload.resolved.join(', ') || '(no A record)'} — public IP not yet known to compare against${dnsAge}`;
    } else if (dnsPayload.resolved.length === 0) {
      rowStatus = 'fail';
      rowDetail = `Public DNS returned no A record — domain doesn't resolve from the internet${dnsAge}`;
    } else if (dnsPayload.matched) {
      rowStatus = 'ok';
      rowDetail = `Public DNS → ${dnsPayload.expected} (matches your gateway)${dnsAge}`;
    } else {
      rowStatus = 'fail';
      rowDetail = `Public DNS → ${dnsPayload.resolved.join(', ')} but your gateway IP is ${dnsPayload.expected}. Update the DNS A record at your registrar${dnsAge}`;
    }

    // Append letsdebug summary line when the operator has run one.
    // Naming which layer is broken matters here: if DNS resolves
    // correctly but letsdebug reports a problem, the cert / ACME /
    // port-80 path is the culprit — not DNS. Operators were running
    // `dig` again on a 'fail' row that already had DNS working;
    // making the layer explicit cuts the diagnostic step.
    if (letsdebugResult) {
      const ldAge = formatRelativeAge(Date.parse(letsdebugResult.timestamp));
      const ldPayload = decodeLetsdebug(letsdebugResult.message);
      const dnsOkBeforeLd = rowStatus === 'ok';
      if (ldPayload) {
        if (ldPayload.problems.length === 0) {
          rowDetail += `\nLetsdebug (${ldAge}): no problems`;
        } else {
          const top = ldPayload.problems[0];
          const layerHint = dnsOkBeforeLd
            ? 'DNS layer OK — issue is in the cert / ACME / port-80 layer.'
            : 'DNS and cert layers both have findings — start with the DNS fix above.';
          rowDetail += `\n${layerHint} Letsdebug (${ldAge}): ${top.name || 'problem'} — ${(top.explanation || '').slice(0, 160)}`;
          if (ldPayload.submissionUrl) rowDetail += ` · ${ldPayload.submissionUrl}`;
          // Letsdebug result escalates row status if DNS said ok.
          const ldStatus: 'warn' | 'fail' = ldPayload.problems.some(p => (p.severity || '').toLowerCase() === 'fatal') ? 'fail' : 'warn';
          if (rowStatus === 'ok') rowStatus = ldStatus;
        }
      } else if (letsdebugResult.status === 'fail') {
        rowDetail += `\nLetsdebug last run failed: ${(letsdebugResult.message ?? '').slice(0, 120)}`;
      }
    }

    // #611 — fold in the HTTP-status check. Worst-of aggregation
    // matches the existing DNS+letsdebug pattern.
    const httpResult = httpResults.get(domain);
    if (httpResult) {
      const httpLayerOk = httpResult.status === 'ok';
      const dnsLayerOk = rowStatus === 'ok';
      if (!httpLayerOk) {
        // Spell out which layer the operator should investigate. A
        // DNS-green + HTTP-fail row almost always means upstream
        // crash (the v4.0.x Authelia case) — name it so the operator
        // doesn't re-run `dig` on a row that's already DNS-correct.
        const hint = dnsLayerOk
          ? 'DNS layer OK — issue is in the upstream backend (NPM → service is failing).'
          : 'DNS layer also has findings — fix that first; HTTP may resolve once DNS is correct.';
        rowDetail += `\n${hint} HTTPS GET: ${httpResult.detail}`;
        rowStatus = worst(rowStatus, httpResult.status);
      }
    }

    // Skip healthy rows from the items list so the probe collapses to a happy summary.
    if (rowStatus === 'ok' && dnsPayload.matched) continue;

    if (rowStatus === 'fail') failedCount++; else warnCount++;
    overall = worst(overall, rowStatus);
    items.push({
      id: domain,
      label: domain,
      detail: rowDetail,
      status: rowStatus,
      actionIds: ['refresh_now', 'run_letsdebug'],
    });
  }

  if (overall === 'ok' && pendingCount === 0) {
    return {
      status: 'ok',
      detail: `${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'} resolving to your public IP.`,
    };
  }

  const parts: string[] = [];
  if (failedCount)   parts.push(`${failedCount} fatal`);
  if (warnCount)     parts.push(`${warnCount} warning`);
  if (pendingCount)  parts.push(`${pendingCount} pending`);

  return {
    status: pendingCount > 0 && overall === 'ok' ? 'info' : overall,
    detail: `${parts.join(' · ')} of ${publicDomains.length} public domain${publicDomains.length === 1 ? '' : 's'}.`,
    hint: 'DNS routing is checked every 15 min via Cloudflare DoH (no rate limits). For the full ACME / port-80 / CAA taxonomy click "Run letsdebug" on a row — that hits letsdebug.net once on demand.',
    items,
  };
}

/**
 * `refresh_now` — operator-initiated single-domain re-probe of the
 * DoH-based `dns_routing` check. Synchronous (sub-second under normal
 * conditions); the UI's auto-refresh picks up the new state without
 * a second click.
 */
async function refreshNow({ itemId }: { itemId?: string }): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No domain supplied — nothing to refresh.', refresh: false };
  }
  const checkId = `${DNS_ROUTING_CHECK_PREFIX}${itemId}`;
  const check = HealthStore.getChecks().find(c => c.id === checkId);
  if (!check) {
    return {
      ok: false,
      message: `No DNS routing check found for ${itemId}. It should appear automatically — try reloading.`,
      refresh: true,
    };
  }
  try {
    const result = await CheckRunner.run(check);
    const payload = decodeDnsRouting(result.message);
    if (!payload) {
      return { ok: false, message: `DNS check failed for ${itemId}: ${(result.message ?? '').slice(0, 160)}`, refresh: true };
    }
    return {
      ok: result.status === 'ok' && payload.matched,
      message: payload.matched
        ? `${itemId} resolves to ${payload.expected} — matches your gateway.`
        : payload.resolved.length === 0
          ? `${itemId} doesn't resolve from public DNS.`
          : `${itemId} resolves to ${payload.resolved.join(', ')} (expected ${payload.expected}).`,
      refresh: true,
    };
  } catch (e) {
    return { ok: false, message: `Refresh failed: ${e instanceof Error ? e.message : String(e)}`, refresh: false };
  }
}

/**
 * `run_letsdebug` — operator-initiated deep external diagnostic via
 * letsdebug.net. Slow (10-30 s) and rate-limited upstream, which is
 * exactly why it's behind a button instead of a recurring sweep.
 * Stores the result under a transient `letsdebug:<domain>` key so
 * the row can render "Letsdebug X ago" alongside the continuous DNS
 * answer until the next refresh overwrites it.
 */
async function runLetsdebug({ itemId }: { itemId?: string }): Promise<ProbeActionResult> {
  if (!itemId) {
    return { ok: false, message: 'No domain supplied — nothing to check.', refresh: false };
  }
  const checkId = `${LETSDEBUG_CHECK_PREFIX}${itemId}`;
  try {
    const result = await runLetsdebugForDomain(itemId);
    const payload = JSON.stringify({
      problems: result.problems,
      submissionUrl: result.submissionUrl,
    });
    const hasFatal = result.problems.some(p => (p.severity || '').toLowerCase() === 'fatal');
    HealthStore.saveResult({
      check_id: checkId,
      timestamp: new Date().toISOString(),
      status: hasFatal ? 'fail' : 'ok',
      message: `${LETSDEBUG_MESSAGE_PREFIX}${payload}`,
    });
    return {
      ok: result.problems.length === 0,
      message: result.problems.length === 0
        ? `${itemId} passed letsdebug — no problems.`
        : `${itemId} has ${result.problems.length} problem(s) — see the row for details.`,
      refresh: true,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('diagnose:run_letsdebug', `${itemId}: ${msg}`);
    HealthStore.saveResult({
      check_id: checkId,
      timestamp: new Date().toISOString(),
      status: 'fail',
      message: msg,
    });
    return {
      ok: false,
      message: msg.includes('429')
        ? `letsdebug rate-limited this request. Try again in a few minutes, or use https://letsdebug.net/?domain=${encodeURIComponent(itemId)}&method=http-01 directly.`
        : `letsdebug failed for ${itemId}: ${msg.slice(0, 160)}`,
      refresh: true,
    };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'refresh_now',
    label: 'Refresh DNS check',
    description:
      'Re-runs the DoH-based DNS routing check for this domain immediately. Free, no rate limits — completes in well under a second.',
  },
  refreshNow,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'run_letsdebug',
    label: 'Run letsdebug',
    description:
      'Deep external diagnostic via letsdebug.net — checks DNS + port 80 + CAA + ACME readiness. Slow (10-30 s) and rate-limited upstream, so use sparingly when DNS routing looks correct but something else is wrong.',
  },
  runLetsdebug,
);

/**
 * Test-only helpers. Exported for the unit test; production code
 * must not call these.
 */
export const _internalsForTesting = {
  formatRelativeAge,
  decodeDnsRouting,
  decodeLetsdebug,
};
