import { CheckConfig, CheckResult } from './types';
import { HealthStore } from './store';
import vm from 'vm';
import { getExecutor, Executor } from '../executor';
import { listNodes, verifyNodeConnection } from '../nodes';
import { agentManager } from '../agent/manager';
import { getConfig } from '../config';
import { assertHttpTargetAllowed } from './ssrfGuard';
import { ContainerId, ServiceName, HostString } from '../api/schemas';
import { runLetsdebugForDomain } from '../letsdebug/client';
import { detectLanIp, recentChanges } from '../lanIp';
import { findNpmAdminUrl, getNpmToken } from './probes/npmAdmin';
import { parseLetsencryptTail } from './probes/letsencryptLogParser';
import { logger } from '../logger';

/**
 * Encoded payload for letsdebug-type results so the diagnose probe
 * can recover the full `{ problems, submissionUrl }` shape from the
 * persisted `CheckResult.message`. Prefix lets cheap consumers
 * detect "structured letsdebug data" vs. "plaintext transport error"
 * without parsing every message.
 */
export const LETSDEBUG_MESSAGE_PREFIX = 'letsdebug:';

/**
 * Phase 3b (#484) — message-prefix discriminators for the four
 * diagnose probes lifted into the health-check subsystem. Each runner
 * encodes its probe-shaped payload as JSON behind the matching prefix
 * so the thin diagnose readers can `JSON.parse` it back into the
 * exact `{ status, detail, hint, items? }` row they used to compute
 * themselves. Plaintext messages (no prefix) mean a transport error
 * and are surfaced as `info` on the diagnose side.
 */
export const LAN_IP_DRIFT_MESSAGE_PREFIX = 'lan_ip_drift:';
export const NPM_AUTH_MESSAGE_PREFIX = 'npm_auth:';
export const CERT_EXPIRY_MESSAGE_PREFIX = 'cert_expiry:';
export const CERT_REQUEST_FAILURE_MESSAGE_PREFIX = 'cert_request_failure:';

export class CheckRunner {
  static async run(check: CheckConfig): Promise<CheckResult> {
    const start = Date.now();
    let status: 'ok' | 'fail' = 'fail';
    let message = '';

    let connection;
    if (check.nodeName && check.nodeName !== 'Local') {
        const nodes = await listNodes();
        connection = nodes.find(n => n.Name === check.nodeName);
    }
    const executor = getExecutor(connection);

    try {
      switch (check.type) {
        case 'http':
          await this.runHttpCheck(check);
          status = 'ok';
          break;
        case 'ping':
          await this.runPingCheck(check.target, executor);
          status = 'ok';
          break;
        case 'script':
          await this.runScriptCheck(check.target);
          status = 'ok';
          break;
        case 'podman':
          await this.runPodmanCheck(check.target, executor);
          status = 'ok';
          break;
        case 'service':
          await this.runServiceCheck(check.target, executor);
          status = 'ok';
          break;
        case 'systemd':
          await this.runSystemdCheck(check.target, executor);
          status = 'ok';
          break;
        case 'node':
          await this.runNodeCheck(check.target);
          status = 'ok';
          break;
        case 'agent':
          const agentMsg = await this.runAgentCheck(check.target);
          if (agentMsg) message = agentMsg;
          status = 'ok';
          break;
        case 'fritzbox':
          const fbMsg = await this.runFritzboxCheck(check);
          if (fbMsg) message = fbMsg;
          status = 'ok';
          break;
        case 'backup':
          const bkMsg = await this.runBackupCheck();
          if (bkMsg) message = bkMsg;
          status = 'ok';
          break;
        case 'domain':
          const domainMsg = await this.runDomainCheck(check);
          if (domainMsg) message = domainMsg;
          status = 'ok';
          break;
        case 'letsdebug': {
          // letsdebug returns 0..N problems with severity 'fatal' or
          // 'warning'. Status 'fail' is reserved for fatal problems +
          // transport errors so the health page only goes red on
          // genuinely broken external reachability; warnings are
          // encoded in the message and the diagnose probe surfaces
          // them as amber rows.
          const r = await this.runLetsdebugCheck(check);
          message = r.message;
          status = r.status;
          break;
        }
        case 'lan_ip_drift': {
          const r = await this.runLanIpDriftCheck(check);
          message = r.message;
          status = r.status;
          break;
        }
        case 'npm_auth': {
          const r = await this.runNpmAuthCheck(check);
          message = r.message;
          status = r.status;
          break;
        }
        case 'cert_expiry': {
          const r = await this.runCertExpiryCheck(check);
          message = r.message;
          status = r.status;
          break;
        }
        case 'cert_request_failure': {
          const r = await this.runCertRequestFailureCheck(check);
          message = r.message;
          status = r.status;
          break;
        }
      }
    } catch (e: unknown) {
      status = 'fail';
      message = e instanceof Error ? e.message : String(e);
    }

    const latency = Date.now() - start;
    const result: CheckResult = {
      check_id: check.id,
      timestamp: new Date().toISOString(),
      status,
      latency,
      message
    };

    HealthStore.saveResult(result);
    return result;
  }

  private static async runHttpCheck(check: CheckConfig) {
    await assertHttpTargetAllowed(check.target);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const res = await fetch(check.target, { signal: controller.signal });
      
      // Check Status
      const expectedStatus = check.httpConfig?.expectedStatus;
      if (expectedStatus) {
        if (res.status !== expectedStatus) {
          throw new Error(`HTTP Status ${res.status} (expected ${expectedStatus})`);
        }
      } else {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }
      }

      // Check Body
      if (check.httpConfig?.bodyMatch) {
        const body = await res.text();
        const pattern = check.httpConfig.bodyMatch;
        const type = check.httpConfig.bodyMatchType || 'contains';

        if (type === 'regex') {
          const regex = new RegExp(pattern);
          if (!regex.test(body)) {
            throw new Error(`Body did not match regex: ${pattern}`);
          }
        } else {
          if (!body.includes(pattern)) {
            throw new Error(`Body did not contain: ${pattern}`);
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Probe a configured domain by talking directly to NPM on the LAN
   * IP with a `Host:` header — *not* by resolving the domain name.
   * This is the only probe that works for `.home.arpa` from inside
   * ServiceBay's container, which doesn't use AdGuard as its own
   * resolver (it uses whatever the host's /etc/resolv.conf points
   * at — typically the FritzBox, which has no answer for the
   * RFC 8375 reserved zone). Public domains also benefit: we test
   * the proxy routing without depending on router hairpin or public
   * DNS being healthy.
   *
   *   1. Hit `http://<lanIp>:80/` with `Host: <domain>`.
   *   2. NPM picks the matching virtual host, applies any
   *      ssl_forced 301 redirect (visible as 301 → Location:
   *      https://<domain>/), and then forwards to the backend.
   *   3. We accept anything 2xx-3xx as "routing healthy".
   *      For `https` (ssl_forced) routes we expect a 301/302
   *      with `Location:` starting `https://<domain>` — that
   *      proves NPM both *knows* this vhost and the cert binding
   *      is in place.
   *   4. NPM's default "Congratulations" body on 404/503 means the
   *      proxy host doesn't exist *yet* for this domain — same
   *      symptom as a half-finished install.
   *
   * No SSRF guard: hitting our own LAN IP is the point.
   */
  private static async runDomainCheck(check: CheckConfig): Promise<string> {
    const cfg = check.domainConfig;
    if (!cfg) throw new Error('domainConfig missing');
    const expectedScheme = cfg.expectedScheme;

    // Resolve NPM's address via config — `reverseProxy.lanIp` is what
    // the install wizard captures and reconciles on every boot.
    const { getConfig } = await import('../config');
    const config = await getConfig();
    const lanIp = config.reverseProxy?.lanIp;
    if (!lanIp) throw new Error('reverseProxy.lanIp not configured — cannot probe NPM');

    const url = `http://${lanIp}:80/`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'manual', // `Location:` of a 301 is the proof of life for ssl_forced.
        headers: { Host: check.target },
      });

      if (res.status === 404 || res.status === 503) {
        const body = await res.text().catch(() => '');
        if (body.includes('Congratulations') || body.includes('nginx-proxy-manager')) {
          throw new Error(`Proxy host for ${check.target} not configured in NPM`);
        }
      }

      // For ssl_forced (public) routes NPM answers 301 → https://...
      // — that's the healthy state for an https-expected domain.
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

  /**
   * Run letsdebug.net against `check.target` (a public domain) and
   * encode the result back into the CheckResult shape.
   *
   *   - reachable, no problems → status 'ok', message ''.
   *   - reachable with warnings only → status 'ok', message
   *     prefixed `letsdebug:` + JSON-encoded payload.
   *   - reachable with a fatal problem → status 'fail', same encoded
   *     payload (so the diagnose probe can render the problem text
   *     and submission URL without re-running the probe).
   *   - transport error / 429 / parse failure → status 'fail',
   *     message is the plaintext error so the operator sees what
   *     happened on the health page directly.
   *
   * The 4 h interval (set in `letsdebugChecks.ts`) is the rate-limit
   * shield — a 429 just means the next scheduled tick wins, and the
   * diagnose probe's per-row `refresh_now` action bypasses the wait
   * if the operator wants confirmation sooner.
   */
  private static async runLetsdebugCheck(
    check: CheckConfig,
  ): Promise<{ status: 'ok' | 'fail'; message: string }> {
    let result;
    try {
      result = await runLetsdebugForDomain(check.target);
    } catch (e) {
      return {
        status: 'fail',
        message: `letsdebug error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (result.problems.length === 0) {
      return { status: 'ok', message: '' };
    }
    const hasFatal = result.problems.some(
      p => (p.severity || '').toLowerCase() === 'fatal',
    );
    const payload = JSON.stringify({
      problems: result.problems,
      submissionUrl: result.submissionUrl,
    });
    return {
      status: hasFatal ? 'fail' : 'ok',
      message: `${LETSDEBUG_MESSAGE_PREFIX}${payload}`,
    };
  }

  /**
   * Phase 3b runner methods — each lifts a former diagnose probe into
   * a periodic health check.  Convention:
   *
   *   - On a successful evaluation we encode the probe's
   *     `{ status, detail, hint?, items? }` JSON behind the
   *     check-type prefix and report `CheckResult.status='ok'` for
   *     payload statuses 'ok' | 'warn' | 'info', and 'fail' for the
   *     payload-level 'fail'.  This keeps the health page green on
   *     yellow/info conditions — the same convention letsdebug uses —
   *     while still broadcasting on every tick so the SSE
   *     auto-refresh wired up in Phase 3a picks up warning changes
   *     too.
   *   - Transport / unexpected errors fall through to a plaintext
   *     `fail` message (no prefix); the diagnose reader displays them
   *     as an `info` row with "Check failed to run: …".
   */

  /**
   * `lan_ip_drift` — compares ServiceBay's currently-detected LAN IP
   * to the install-time value captured in
   * `config.reverseProxy.lanIp`. Mirrors the former
   * `checkLanIpChanged` probe.
   */
  private static async runLanIpDriftCheck(
    check: CheckConfig,
  ): Promise<{ status: 'ok' | 'fail'; message: string }> {
    const RECENT_DAYS = 30;
    const RECENT_THRESHOLD = 1;
    try {
      const config = await getConfig();
      const stored = config.reverseProxy?.lanIp;
      const node = check.nodeName ?? 'Local';
      const current = await detectLanIp(node);

      let payload: { status: 'ok' | 'warn' | 'info'; detail: string; hint?: string };
      if (!current) {
        payload = {
          status: 'info',
          detail: 'Could not detect ServiceBay\'s LAN IP — `ip route get` returned no result.',
        };
      } else if (!stored) {
        payload = {
          status: 'info',
          detail: `LAN IP is ${current}. No install-time value recorded yet.`,
        };
      } else {
        const history = config.reverseProxy?.lanIpHistory ?? [];
        const changes = recentChanges(history, RECENT_DAYS);
        if (current === stored) {
          if (changes > RECENT_THRESHOLD) {
            payload = {
              status: 'warn',
              detail: `LAN IP is currently ${current}, matching install. But it has changed ${changes} times in the last ${RECENT_DAYS} days.`,
              hint: 'Set up a DHCP reservation in your router so the IP doesn\'t drift — this avoids brief outages while AdGuard rewrites + NPM forward-hosts catch up.',
            };
          } else {
            payload = {
              status: 'ok',
              detail: `LAN IP ${current} matches the install-time value.`,
            };
          }
        } else {
          payload = {
            status: 'warn',
            detail: `LAN IP is now ${current}, but install-time was ${stored}. AdGuard rewrites + NPM forward-hosts will be reconciled on next boot.`,
            hint:
              changes > RECENT_THRESHOLD
                ? `This is the ${changes + 1}-th change in the last ${RECENT_DAYS} days — set a DHCP reservation in your router to stop the drift.`
                : 'A one-off change is fine; ServiceBay reconciles automatically on the next boot.',
          };
        }
      }
      return {
        status: 'ok',
        message: `${LAN_IP_DRIFT_MESSAGE_PREFIX}${JSON.stringify(payload)}`,
      };
    } catch (e) {
      return {
        status: 'fail',
        message: `lan_ip_drift error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * `npm_auth` — verifies that the stored NPM admin credentials still
   * work against the locally-running NPM instance. Mirrors the former
   * `checkNpmDataStale` probe; 401 → stale (payload `fail`),
   * unreachable / 5xx → info, 2xx → ok.
   */
  private static async runNpmAuthCheck(
    check: CheckConfig,
  ): Promise<{ status: 'ok' | 'fail'; message: string }> {
    const node = check.nodeName ?? 'Local';
    try {
      const config = await getConfig();
      const npm = config.reverseProxy?.npm;
      const encode = (payload: { status: 'ok' | 'warn' | 'fail' | 'info'; detail: string; hint?: string }) =>
        ({ status: payload.status === 'fail' ? ('fail' as const) : ('ok' as const), message: `${NPM_AUTH_MESSAGE_PREFIX}${JSON.stringify(payload)}` });

      if (!npm?.email || !npm?.password) {
        return encode({ status: 'info', detail: 'No NPM admin credentials stored — skipping staleness check.' });
      }
      const adminUrl = await findNpmAdminUrl(node);
      if (!adminUrl) {
        return encode({ status: 'info', detail: 'Nginx Proxy Manager not deployed on this node — nothing to check.' });
      }
      try {
        const res = await fetch(`${adminUrl}/api/tokens`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identity: npm.email, secret: npm.password }),
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          return encode({ status: 'ok', detail: 'NPM accepts the stored admin credentials.' });
        }
        if (res.status === 401) {
          return encode({
            status: 'fail',
            detail:
              'Nginx Proxy Manager is rejecting the stored admin credentials. This usually means a previous install left an admin password in the NPM database that no longer matches.',
            hint: 'If you know the password NPM is actually using, click "Use existing password" below to save it (no data loss). Otherwise "Reset NPM data" wipes the database and re-seeds with the wizard credentials.',
          });
        }
        return encode({ status: 'info', detail: `NPM auth probe returned HTTP ${res.status} — assuming transient.` });
      } catch (e) {
        return encode({
          status: 'info',
          detail: `Could not reach NPM at ${adminUrl}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    } catch (e) {
      return {
        status: 'fail',
        message: `npm_auth error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * `cert_expiry` — lists NPM-managed Let's Encrypt certificates and
   * flags those expiring within 14 days (warn) or already expired
   * (fail). Items carry the numeric NPM cert id, which the diagnose
   * row's `renew_cert` action uses to call NPM's renew endpoint.
   */
  private static async runCertExpiryCheck(
    check: CheckConfig,
  ): Promise<{ status: 'ok' | 'fail'; message: string }> {
    const WARN_DAYS = 14;
    const node = check.nodeName ?? 'Local';
    interface NpmCert {
      id: number;
      provider?: string;
      domain_names?: string[];
      expires_on?: string;
    }
    interface CertItem {
      id: string;
      label: string;
      detail: string;
      status: 'warn' | 'fail';
      actionIds: string[];
    }
    const encode = (payload: { status: 'ok' | 'warn' | 'fail' | 'info'; detail: string; hint?: string; items?: CertItem[] }) =>
      ({ status: payload.status === 'fail' ? ('fail' as const) : ('ok' as const), message: `${CERT_EXPIRY_MESSAGE_PREFIX}${JSON.stringify(payload)}` });

    try {
      const adminUrl = await findNpmAdminUrl(node);
      if (!adminUrl) {
        return encode({ status: 'info', detail: 'Nginx Proxy Manager not deployed — no certificates to check.' });
      }
      const token = await getNpmToken(adminUrl);
      if (!token) {
        return encode({ status: 'info', detail: 'Could not authenticate with NPM — skipping certificate check.' });
      }
      let certs: NpmCert[];
      try {
        const res = await fetch(`${adminUrl}/api/nginx/certificates`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) {
          return encode({ status: 'info', detail: `NPM certificates API returned HTTP ${res.status}.` });
        }
        certs = (await res.json()) as NpmCert[];
      } catch (e) {
        return encode({ status: 'info', detail: `Could not list NPM certificates: ${e instanceof Error ? e.message : String(e)}` });
      }

      const leCerts = (certs ?? []).filter(c => c.provider === 'letsencrypt');
      if (leCerts.length === 0) {
        return encode({ status: 'info', detail: 'No Let\'s Encrypt certificates managed by NPM.' });
      }
      const now = Date.now();
      const items: CertItem[] = [];
      let expiringSoon = 0;
      let expired = 0;
      for (const c of leCerts) {
        if (!c.expires_on) continue;
        const exp = Date.parse(c.expires_on);
        if (!Number.isFinite(exp)) continue;
        const daysLeft = Math.floor((exp - now) / (1000 * 60 * 60 * 24));
        const domains = (c.domain_names ?? []).join(', ') || `cert ${c.id}`;
        if (daysLeft < 0) {
          expired += 1;
          items.push({
            id: String(c.id),
            label: domains,
            detail: `EXPIRED ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago — services served via this cert show browser warnings.`,
            status: 'fail',
            actionIds: ['renew_cert'],
          });
        } else if (daysLeft <= WARN_DAYS) {
          expiringSoon += 1;
          items.push({
            id: String(c.id),
            label: domains,
            detail: `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
            status: 'warn',
            actionIds: ['renew_cert'],
          });
        }
      }
      if (items.length === 0) {
        return encode({
          status: 'ok',
          detail: `${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'} managed; none expiring in ${WARN_DAYS} days.`,
        });
      }
      const status: 'warn' | 'fail' = expired > 0 ? 'fail' : 'warn';
      return encode({
        status,
        detail:
          expired > 0
            ? `${expired} expired + ${expiringSoon} expiring soon out of ${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'}.`
            : `${expiringSoon} of ${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'} expiring within ${WARN_DAYS} days.`,
        hint:
          'NPM auto-renews on a schedule; click "Renew now" if you want to force a refresh ahead of expiry. Failed renewals usually mean DNS or port-80 challenge changed since issuance.',
        items,
      });
    } catch (e) {
      return {
        status: 'fail',
        message: `cert_expiry error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * `cert_request_failure` — tails NPM's `letsencrypt.log` and
   * extracts recent ACME failures via the shared
   * `parseLetsencryptTail` parser (kept in the diagnose-side module
   * since it has its own dedicated test). Each failed domain becomes
   * a payload item carrying the show_log_tail + retry_request
   * action ids.
   */
  private static async runCertRequestFailureCheck(
    check: CheckConfig,
  ): Promise<{ status: 'ok' | 'fail'; message: string }> {
    const FRESHNESS_HOURS = 24;
    const TAIL_BYTES = 65_536;
    const node = check.nodeName ?? 'Local';
    interface CrfItem {
      id: string;
      label: string;
      detail: string;
      status: 'fail';
      actionIds: string[];
    }
    const encode = (payload: { status: 'ok' | 'warn' | 'fail' | 'info'; detail: string; hint?: string; items?: CrfItem[] }) =>
      ({ status: payload.status === 'fail' ? ('fail' as const) : ('ok' as const), message: `${CERT_REQUEST_FAILURE_MESSAGE_PREFIX}${JSON.stringify(payload)}` });

    const safePath = (p: string) => /^\/[A-Za-z0-9_./-]+$/.test(p);

    try {
      const config = await getConfig();
      const dataDir = config.templateSettings?.DATA_DIR ?? '/mnt/data';
      const path = `${dataDir}/nginx-proxy-manager/data/logs/letsencrypt.log`;
      if (!safePath(path)) {
        logger.warn('health:cert_request_failure', `Refusing tail of unsafe path: ${path}`);
        return encode({ status: 'info', detail: 'NPM data dir is not a safe POSIX absolute path — skipping log read.' });
      }

      // Read the log tail via the agent. Mirrors the former probe's
      // `readLogTail`. Any error → info (treated identically to
      // "log doesn't exist yet"); the existing pods / npm_auth probes
      // already cover hard NPM-down cases.
      let tail = '';
      try {
        const agent = await agentManager.ensureAgent(node);
        const res = (await agent.sendCommand(
          'exec',
          { command: `tail -c ${TAIL_BYTES} ${path} 2>/dev/null` },
          { timeoutMs: 5_000 },
        )) as { code?: number; stdout?: string };
        if (res.code !== 0) {
          return encode({ status: 'info', detail: 'No letsencrypt.log found — NPM hasn\'t attempted any cert requests yet.' });
        }
        tail = res.stdout ?? '';
      } catch (e) {
        logger.warn(
          'health:cert_request_failure',
          `tail letsencrypt.log failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return encode({ status: 'info', detail: 'Could not read letsencrypt.log — assuming no cert requests yet.' });
      }
      if (tail.length === 0) {
        return encode({ status: 'info', detail: 'No letsencrypt.log found — NPM hasn\'t attempted any cert requests yet.' });
      }

      const parsed = parseLetsencryptTail(tail);
      if (parsed.failures.length === 0 && !parsed.rateLimited) {
        return encode({ status: 'ok', detail: 'No Let\'s Encrypt cert failures in the recent NPM log.' });
      }
      if (parsed.ts) {
        const ageMs = Date.now() - parsed.ts;
        if (ageMs > FRESHNESS_HOURS * 3_600_000) {
          return encode({
            status: 'ok',
            detail: `Last cert failure was ${Math.round(ageMs / 3_600_000)}h ago (outside the ${FRESHNESS_HOURS}h freshness window). Treating as resolved.`,
          });
        }
      }

      const byDomain = new Map<string, { domain: string; type: string; detail: string }>();
      for (const f of parsed.failures) byDomain.set(f.domain, f);
      const items: CrfItem[] = [];
      for (const [domain, f] of byDomain) {
        const detail = f.detail.length > 140 ? `${f.detail.slice(0, 140)}…` : f.detail;
        items.push({
          id: domain,
          label: domain,
          detail: `ACME ${f.type} challenge failed: ${detail}`,
          status: 'fail',
          actionIds: ['show_log_tail', 'retry_request'],
        });
      }
      if (parsed.rateLimited && items.length === 0) {
        items.push({
          id: 'rate-limited',
          label: 'Let\'s Encrypt rate limit',
          detail: 'Hit the ACME rate limit (5 failed validations / host / hour). Wait ~1h and fix the root cause before retrying.',
          status: 'fail',
          actionIds: ['show_log_tail'],
        });
      }
      return encode({
        status: 'fail',
        detail: `${items.length} domain${items.length === 1 ? '' : 's'} with recent ACME failure${items.length === 1 ? '' : 's'} in NPM\'s letsencrypt.log.`,
        hint: 'Most common cause is public port 80 not reachable from the internet. Run letsdebug.net for an external view of what the ACME server sees, then click Retry once the underlying cause is fixed.',
        items,
      });
    } catch (e) {
      return {
        status: 'fail',
        message: `cert_request_failure error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  private static async runPingCheck(host: string, executor: Executor) {
    const validatedHost = HostString.parse(host);
    try {
      const { stdout } = await executor.execArgv(['ping', '-c', '1', '-W', '2', validatedHost]);
      if (!stdout.includes('1 received')) {
        throw new Error('Ping failed: no reply');
      }
    } catch (e) {
      throw new Error(`Ping ${validatedHost} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private static async runPodmanCheck(containerName: string, executor: Executor) {
    const validated = ContainerId.parse(containerName);
    try {
        const { stdout } = await executor.execArgv([
            'podman', 'inspect', validated,
            '--format', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
        ]);
        const [status, health] = stdout.trim().split('|');

        if (status !== 'running') {
            throw new Error(`Container is ${status}`);
        }

        if (health !== 'none' && health !== 'healthy') {
            throw new Error(`Container health is ${health}`);
        }
    } catch (e) {
        // If the container is not found, podman inspect returns exit code 125 or 1
        throw new Error(`Container ${validated} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private static async runServiceCheck(serviceName: string, executor: Executor) {
    const validated = ServiceName.parse(serviceName);
    const unit = validated.includes('.') ? validated : `${validated}.service`;

    try {
        const { stdout } = await executor.execArgv(['systemctl', '--user', 'is-active', unit]);
        const status = stdout.trim();
        if (status !== 'active') {
            throw new Error(`Service is ${status}`);
        }
    } catch (e) {
        throw new Error(`Service ${unit} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private static async runSystemdCheck(unitName: string, executor: Executor) {
    const validated = ServiceName.parse(unitName);
    try {
        const { stdout } = await executor.execArgv(['systemctl', 'is-active', validated]);
        const status = stdout.trim();
        if (status !== 'active') {
            throw new Error(`System unit is ${status}`);
        }
    } catch (e) {
        throw new Error(`System unit ${validated} check failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private static async runScriptCheck(script: string) {
    const safeSetTimeout = (fn: (...args: unknown[]) => void, ms: number) => setTimeout(fn, Math.min(ms, 5000));
    const safeClearTimeout = (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
    const sandbox = {
        fetch: global.fetch,
        console: { log: () => {} },
        setTimeout: safeSetTimeout,
        clearTimeout: safeClearTimeout,
    };
    
    const context = vm.createContext(sandbox);
    
    // Wrap in async IIFE
    const code = `(async () => {
        ${script}
    })()`;
    
    try {
        const result = vm.runInContext(code, context, { timeout: 5000 });
        // Check if result is thenable (Promise-like) since VM Promise != Host Promise
        if (result && typeof result.then === 'function') {
            await result;
        }
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Script failed: ${msg}`);
    }
  }

  private static async runNodeCheck(nodeName: string) {
    const result = await verifyNodeConnection(nodeName);
    if (!result.success) {
        throw new Error(`Node connection failed: ${result.error || 'Unknown error'}`);
    }
  }

  private static async runFritzboxCheck(check: CheckConfig): Promise<string> {
    const host = check.fritzboxConfig?.host || check.target || 'fritz.box';
    const port = 49000;
    const service = 'urn:schemas-upnp-org:service:WANIPConnection:1';
    const action = 'GetStatusInfo';
    const url = `http://${host}:${port}/igdupnp/control/WANIPConn1`;

    const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
<s:Body>
<u:${action} xmlns:u="${service}" />
</s:Body>
</s:Envelope>`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml; charset="utf-8"',
                'SoapAction': `${service}#${action}`
            },
            body: soapBody,
            signal: controller.signal
        });

        if (!res.ok) {
            if (res.status === 401) {
                 throw new Error('FritzBox requires authentication. Please check if "Status information over UPnP" is enabled in Home Network > Network > Network Settings.');
            }
            if (res.status === 500) {
                // SOAP Fault?
                const text = await res.text();
                if (text.includes('Invalid Action')) {
                     throw new Error('FritzBox API: Invalid Action. The device might not support WANIPConnection:1.');
                }
            }
            throw new Error(`FritzBox API Error: ${res.status} ${res.statusText}`);
        }

        const text = await res.text();
        // Parse XML for NewConnectionStatus
        const match = text.match(/<NewConnectionStatus>(.*?)<\/NewConnectionStatus>/);
        if (!match) throw new Error('Invalid response from FritzBox (missing NewConnectionStatus)');
        
        const status = match[1];
        if (status !== 'Connected') {
            throw new Error(`Internet connection is ${status}`);
        }

        // Parse Uptime
        const uptimeMatch = text.match(/<NewUptime>(.*?)<\/NewUptime>/);
        const uptime = uptimeMatch ? parseInt(uptimeMatch[1], 10) : 0;
        
        // Format uptime
        const days = Math.floor(uptime / 86400);
        const hours = Math.floor((uptime % 86400) / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        
        let uptimeStr = '';
        if (days > 0) uptimeStr += `${days}d `;
        if (hours > 0) uptimeStr += `${hours}h `;
        uptimeStr += `${minutes}m`;

        return `Connected (Uptime: ${uptimeStr})`;
    } finally {
        clearTimeout(timeout);
    }
  }

  private static async runBackupCheck(): Promise<string> {
    const config = await getConfig();
    const backup = config.backup;

    if (!backup?.enabled) {
      throw new Error('Backup sync is not enabled');
    }

    if (!backup.lastRun) {
      throw new Error('No backup has been run yet');
    }

    if (backup.lastStatus === 'error') {
      throw new Error(`Last backup failed: ${backup.lastMessage || 'Unknown error'}`);
    }

    // Check if backup is overdue (2x the expected interval)
    const lastRun = new Date(backup.lastRun).getTime();
    const now = Date.now();
    const intervalMs = {
      hourly: 60 * 60 * 1000,
      daily: 24 * 60 * 60 * 1000,
      weekly: 7 * 24 * 60 * 60 * 1000,
      monthly: 31 * 24 * 60 * 60 * 1000,
    }[backup.schedule] || 24 * 60 * 60 * 1000;

    const overdueThreshold = intervalMs * 2;
    if (now - lastRun > overdueThreshold) {
      const hoursAgo = Math.round((now - lastRun) / 3600000);
      throw new Error(`Backup is overdue: last run ${hoursAgo}h ago`);
    }

    const durationStr = backup.lastDuration ? ` in ${backup.lastDuration}s` : '';
    return `Last backup OK${durationStr} (${new Date(backup.lastRun).toLocaleString()})`;
  }

  private static async runAgentCheck(nodeName: string): Promise<string> {
    const agent = agentManager.getAgent(nodeName);
    let health = agent.getHealth();
    
    // Auto-connect / heal if disconnected
    if (!health.isConnected) {
        try {
            await agent.start();
            health = agent.getHealth();
        } catch (e) {
            // Keep original error handling if start fails
             const msg = e instanceof Error ? e.message : String(e);
             throw new Error(`Agent disconnected & restart failed: ${msg}`);
        }
    }
    
    if (!health.isConnected) {
        throw new Error(`Agent is disconnected (Last error: ${health.lastError || 'None'})`);
    }

    // Check for stale heartbeat
    // "Last Sync" is updated on any data received. 
    // If agent is connected but silent for too long, it might be zombie.
    // However, if no events happen, it might be silent.
    // Ideally agents send periodic heartbeats (e.g. status updates).
    // Let's assume > 5 minutes silence is suspicious if we expect keepalives.
    const silence = Date.now() - health.lastSync;
    if (silence > 300000) { 
        // 5 minutes
        throw new Error(`Agent connection stalled? No data for ${Math.floor(silence/1000)}s`);
    }

    let status = `Connected.`;
    if (health.messageCount > 0) status += ` Msgs: ${health.messageCount}`;
    if (health.errorCount > 0) status += ` Errs: ${health.errorCount}`;
    
    return status;
  }
}
