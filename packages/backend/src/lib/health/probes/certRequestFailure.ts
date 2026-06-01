/**
 * `cert_request_failure` probe — tails NPM's letsencrypt.log and
 * extracts recent ACME failures via parseLetsencryptTail.
 */

import { registerProbe } from './registry';
import { getConfig } from '../../config';
import { agentManager } from '../../agent/manager';
import { parseLetsencryptTail, categoryLabel, type FailureCategory } from './letsencryptLogParser';
import { logger } from '../../logger';

export const CERT_REQUEST_FAILURE_MESSAGE_PREFIX = 'cert_request_failure:';

interface CrfItem { id: string; label: string; detail: string; status: 'fail'; actionIds: string[]; }
type Payload = { status: 'ok' | 'warn' | 'fail' | 'info'; detail: string; hint?: string; items?: CrfItem[] };

const encode = (payload: Payload) => ({
  status: payload.status === 'fail' ? ('fail' as const) : ('ok' as const),
  message: `${CERT_REQUEST_FAILURE_MESSAGE_PREFIX}${JSON.stringify(payload)}`,
});

const FRESHNESS_HOURS = 24;
const TAIL_BYTES = 65_536;
const safePath = (p: string) => /^\/[A-Za-z0-9_./-]+$/.test(p);

function buildHint(categories: Set<FailureCategory>): string {
  if (categories.size === 1) {
    const [only] = Array.from(categories);
    switch (only) {
      case 'rate-limit':
        return "Let's Encrypt blocks repeated identical requests. Wait the window out (1h for failed-auth, 168h for duplicate-certs) before retrying — and fix the underlying cause first.";
      case 'port-80':
        return 'ACME HTTP-01 needs port 80 reachable from the public internet. Check router port-forwarding to this LAN IP and any upstream ISP block.';
      case 'dns':
        return 'The domain must resolve from public DNS to your gateway IP. Check the A record at your registrar — `domain_external_reachability` shows what public resolvers see today.';
      case 'caa':
        return "A CAA record at your domain forbids Let's Encrypt from issuing. Add `0 issue \"letsencrypt.org\"` at your registrar (or remove the restrictive CAA record entirely).";
      case 'dnssec':
        return "DNSSEC chain is broken — the validator can't verify your A record. Fix DS / DNSKEY at your registrar, or disable DNSSEC for this zone until you can.";
      case 'tls-sni':
        return 'Legacy TLS-SNI challenge type — NPM should be using HTTP-01 by default. Re-create the certificate entry in NPM to force HTTP-01.';
      case 'other':
        return "Read the detail line — certbot's wording usually names the exact cause. Run letsdebug.net for an external view of what the ACME server sees.";
    }
  }
  return 'Multiple failure types in the log — see each row for its category. Run letsdebug.net for an external view of what the ACME server sees, then click Retry once the underlying cause is fixed.';
}

registerProbe({
  type: 'cert_request_failure',
  async run(check) {
    const node = check.nodeName ?? 'Local';
    try {
      const config = await getConfig();
      const dataDir = config.templateSettings?.DATA_DIR ?? '/mnt/data';
      const path = `${dataDir}/nginx-proxy-manager/data/logs/letsencrypt.log`;
      if (!safePath(path)) {
        logger.warn('health:cert_request_failure', `Refusing tail of unsafe path: ${path}`);
        return encode({ status: 'info', detail: 'NPM data dir is not a safe POSIX absolute path — skipping log read.' });
      }

      let tail = '';
      try {
        const agent = await agentManager.ensureAgent(node);
        const res = (await agent.sendCommand(
          'exec',
          { command: `tail -c ${TAIL_BYTES} ${path} 2>/dev/null` },
          { timeoutMs: 5_000 },
        )) as { code?: number; stdout?: string };
        if (res.code !== 0) return encode({ status: 'info', detail: "No letsencrypt.log found — NPM hasn't attempted any cert requests yet." });
        tail = res.stdout ?? '';
      } catch (e) {
        logger.warn('health:cert_request_failure', `tail letsencrypt.log failed: ${e instanceof Error ? e.message : String(e)}`);
        return encode({ status: 'info', detail: 'Could not read letsencrypt.log — assuming no cert requests yet.' });
      }
      if (tail.length === 0) return encode({ status: 'info', detail: "No letsencrypt.log found — NPM hasn't attempted any cert requests yet." });

      const parsed = parseLetsencryptTail(tail);
      if (parsed.failures.length === 0 && !parsed.rateLimited) {
        return encode({ status: 'ok', detail: "No Let's Encrypt cert failures in the recent NPM log." });
      }
      if (parsed.ts) {
        const ageMs = Date.now() - parsed.ts;
        if (ageMs > FRESHNESS_HOURS * 3_600_000) {
          return encode({ status: 'ok', detail: `Last cert failure was ${Math.round(ageMs / 3_600_000)}h ago (outside the ${FRESHNESS_HOURS}h freshness window). Treating as resolved.` });
        }
      }

      const byDomain = new Map<string, typeof parsed.failures[number]>();
      for (const f of parsed.failures) byDomain.set(f.domain, f);
      const items: CrfItem[] = [];
      const categories = new Set<FailureCategory>();
      for (const [domain, f] of byDomain) {
        const detail = f.detail.length > 140 ? `${f.detail.slice(0, 140)}…` : f.detail;
        categories.add(f.category);
        items.push({
          id: domain,
          label: domain,
          detail: `${categoryLabel(f.category)} — ${f.type} challenge: ${detail}`,
          status: 'fail',
          actionIds: ['show_log_tail', 'retry_request'],
        });
      }
      if (parsed.rateLimited && items.length === 0) {
        categories.add('rate-limit');
        items.push({
          id: 'rate-limited',
          label: "Let's Encrypt rate limit",
          detail: `${categoryLabel('rate-limit')} — 5 failed validations / host / hour. Wait ~1h and fix the root cause before retrying.`,
          status: 'fail',
          actionIds: ['show_log_tail'],
        });
      }

      const hint = buildHint(categories);

      return encode({
        status: 'fail',
        detail: `${items.length} domain${items.length === 1 ? '' : 's'} with recent ACME failure${items.length === 1 ? '' : 's'} (${Array.from(categories).map(categoryLabel).join(', ')}).`,
        hint,
        items,
      });
    } catch (e) {
      return { status: 'fail', message: `cert_request_failure error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
