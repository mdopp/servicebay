/**
 * `cert_request_failure` probe — parses the tail of NPM's
 * `letsencrypt.log` and surfaces recent ACME failures (the underlying
 * reason NPM returns its opaque "Internal Error" when a cert request
 * fails). Each failed domain becomes a per-row item with a `show_log_tail`
 * action (returns the last ~80 lines of letsencrypt.log in the
 * expandable details block) and a `retry_request` action (re-runs NPM's
 * renew endpoint).
 *
 * Phase 3b of the diagnose / health-check rework (#484): this probe
 * is now a **thin reader** over the health-check subsystem. Detection
 * runs on a `cert_request_failure`-type singleton check (10 min
 * interval, see `health/init.ts`); the runner calls into the shared
 * parser at `health/probes/letsencryptLogParser.ts`.  Result
 * persistence, scheduling, and the Phase 3a SSE broadcast all live in
 * the health subsystem — this file just reads the latest result back
 * into the diagnose narrative.
 *
 * The two action handlers (`show_log_tail`, `retry_request`) stay
 * here because they mutate NPM state at click-time (one-shot read or
 * cert renew).
 *
 * `parseLetsencryptTail` is re-exported from the new shared module so
 * the existing test in `certRequestFailure.test.ts` keeps importing it
 * from this path unchanged.
 */

import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';
import { HealthStore } from '@/lib/health/store';
import { CERT_REQUEST_FAILURE_MESSAGE_PREFIX } from '@/lib/health/runner';
import { parseLetsencryptTail } from '@/lib/health/probes/letsencryptLogParser';
import { registerRefreshNow } from './refreshHealthCheck';

// Re-export so callers (and the existing unit test) can import the
// parser via the old module path.
export { parseLetsencryptTail };

const PROBE_ID = 'cert_request_failure';
const CHECK_ID = 'cert_request_failure';

export interface CertRequestFailureResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

/** Reader: surfaces the latest persisted `cert_request_failure`
 *  health-check result. Diagnose route used to call this with
 *  `(nodeName)` — the arg is now unused; the singleton check captures
 *  the node via its `nodeName` field. */
export async function checkCertRequestFailure(): Promise<CertRequestFailureResult> {
  const result = HealthStore.getLastResult(CHECK_ID);
  if (!result) {
    // #664 — S4: distinguish missing-prereq from pending-schedule.
    // The le_request_failure check is created at NPM bootstrap.
    const exists = HealthStore.getChecks().some(c => c.id === CHECK_ID);
    if (!exists) {
      return {
        status: 'info',
        detail: 'Waiting on NPM bootstrap — the LE request-failure check is created once the proxy stack is in place.',
      };
    }
    return {
      status: 'info',
      detail: 'Scheduled — first run pending. Open Settings → Health to trigger it manually.',
    };
  }
  if (result.message && result.message.startsWith(CERT_REQUEST_FAILURE_MESSAGE_PREFIX)) {
    try {
      const json = result.message.slice(CERT_REQUEST_FAILURE_MESSAGE_PREFIX.length);
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed.status === 'string' && typeof parsed.detail === 'string') {
        return {
          status: parsed.status,
          detail: parsed.detail,
          hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
          items: Array.isArray(parsed.items) ? (parsed.items as ProbeItem[]) : undefined,
        };
      }
    } catch {
      // fall through
    }
  }
  if (result.status === 'fail') {
    return {
      status: 'info',
      detail: `Check failed to run: ${result.message || 'unknown error'}`,
    };
  }
  return { status: 'info', detail: 'Cert request failure check produced no actionable signal.' };
}

// ─── Action handlers (kept in the probe file) ───────────────────────────

const TAIL_BYTES_FOR_DISPLAY = 16_384;

function letsencryptLogPath(dataDir: string): string {
  return `${dataDir}/nginx-proxy-manager/data/logs/letsencrypt.log`;
}

function safePath(p: string): boolean {
  return /^\/[A-Za-z0-9_./-]+$/.test(p);
}

async function readLogTail(node: string, path: string, bytes: number): Promise<string | null> {
  if (!safePath(path)) {
    logger.warn('diagnose:cert_request_failure', `Refusing tail of unsafe path: ${path}`);
    return null;
  }
  try {
    const agent = await agentManager.ensureAgent(node);
    const res = await agent.sendCommand('exec', {
      command: `tail -c ${bytes} ${path} 2>/dev/null`,
    }, { timeoutMs: 5_000 }) as { code?: number; stdout?: string };
    if (res.code !== 0) return null;
    return res.stdout ?? '';
  } catch (e) {
    logger.warn('diagnose:cert_request_failure', `tail letsencrypt.log failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function findNpmAdminUrl(node: string): Promise<string | null> {
  try {
    const services = await ServiceManager.listServices(node);
    const nginx = services.find(
      s => s.name === 'nginx' || s.name === 'nginx-web' || (s.name.includes('nginx') && !s.name.startsWith('install-')),
    );
    if (!nginx?.active) return null;
    const ports = (nginx.ports ?? [])
      .map(p => parseInt(String(p.host ?? ''), 10))
      .filter(p => Number.isFinite(p) && p !== 80 && p !== 443);
    return `http://localhost:${ports[0] ?? 81}`;
  } catch {
    return null;
  }
}

async function getNpmToken(adminUrl: string): Promise<string | null> {
  const config = await getConfig();
  const candidates: { identity: string; secret: string }[] = [];
  const stored = config.reverseProxy?.npm;
  if (stored?.email && stored?.password) {
    candidates.push({ identity: stored.email, secret: stored.password });
  }
  candidates.push({ identity: 'admin@example.com', secret: 'changeme' });
  for (const cred of candidates) {
    try {
      const res = await fetch(`${adminUrl}/api/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cred),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.token === 'string') return data.token;
      }
    } catch { /* try next */ }
  }
  return null;
}

async function showLogTail({ node }: { node: string }): Promise<ProbeActionResult> {
  const config = await getConfig();
  const dataDir = config.templateSettings?.DATA_DIR ?? '/mnt/data';
  const path = letsencryptLogPath(dataDir);
  const tail = await readLogTail(node, path, TAIL_BYTES_FOR_DISPLAY);
  if (tail === null) {
    return { ok: false, message: `Could not read ${path}.`, refresh: false };
  }
  const lines = tail.split('\n');
  const slice = lines.slice(-80).join('\n');
  return {
    ok: true,
    message: `Showing the last ${Math.min(80, lines.length)} lines of letsencrypt.log.`,
    details: slice,
    refresh: false,
  };
}

async function retryRequest({ node, itemId }: { node: string; itemId?: string }): Promise<ProbeActionResult> {
  if (!itemId) return { ok: false, message: 'No domain supplied.', refresh: false };
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) {
    return { ok: false, message: 'Nginx Proxy Manager is not deployed on this node.', refresh: false };
  }
  const token = await getNpmToken(adminUrl);
  if (!token) {
    return {
      ok: false,
      message: 'Could not authenticate against NPM — fix the npm_data_stale probe first.',
      refresh: false,
    };
  }

  let certId: number | null = null;
  try {
    const res = await fetch(`${adminUrl}/api/nginx/certificates`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return { ok: false, message: `NPM returned HTTP ${res.status} listing certificates.`, refresh: false };
    }
    const certs = await res.json() as Array<{ id?: number; domain_names?: string[] }>;
    for (const c of certs) {
      if ((c.domain_names ?? []).includes(itemId) && typeof c.id === 'number') {
        certId = c.id;
        break;
      }
    }
  } catch (e) {
    return { ok: false, message: `Could not reach NPM: ${e instanceof Error ? e.message : String(e)}`, refresh: false };
  }
  if (certId === null) {
    return {
      ok: false,
      message: `No NPM certificate exists for ${itemId} yet — open NPM admin → SSL Certificates → "Add Let's Encrypt Certificate" to create one. (The failure log entry came from a request that didn't successfully create the cert row.)`,
      refresh: false,
    };
  }

  try {
    const res = await fetch(`${adminUrl}/api/nginx/certificates/${certId}/renew`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('diagnose:cert_request_failure', `Retry id=${certId} (${itemId}) returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      return {
        ok: false,
        message: `NPM returned HTTP ${res.status}. Open NPM admin → SSL Certificates for the live error, or run letsdebug.net to confirm port 80 is publicly reachable.`,
        refresh: false,
      };
    }
    return {
      ok: true,
      message: `Re-requested certificate for ${itemId}. Re-run diagnose in ~30 s; if it fails again the underlying cause (DNS / port 80 / CAA) is still present.`,
      refresh: true,
    };
  } catch (e) {
    return { ok: false, message: `Could not reach NPM: ${e instanceof Error ? e.message : String(e)}`, refresh: false };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'show_log_tail',
    label: 'Show log tail',
    description: 'Returns the last ~80 lines of NPM\'s letsencrypt.log in an expandable code block so you can see the full certbot error context — the ACME response that triggered the failure is usually within 10 lines of the timestamp.',
  },
  showLogTail,
);

registerProbeAction(
  PROBE_ID,
  {
    id: 'retry_request',
    label: 'Retry now',
    description: 'Re-runs NPM\'s cert renewal for this domain. Useful when the underlying cause was transient (rate limit just expired, brief router blip). If the root cause is still present, certbot will fail again with the same error.',
  },
  retryRequest,
);

registerRefreshNow(PROBE_ID, CHECK_ID, 'Cert request failure');
