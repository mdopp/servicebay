/**
 * `cert_request_failure` probe — parses the tail of NPM's
 * `letsencrypt.log` and surfaces recent ACME failures (the underlying
 * reason NPM returns its opaque "Internal Error" when a cert request
 * fails). Each failed domain becomes a per-row item with a `show_log_tail`
 * action (returns the last ~80 lines of letsencrypt.log in the
 * expandable details block) and a `retry_request` action (re-runs NPM's
 * renew endpoint).
 *
 * Silent (info) when no log exists, when the last failure is older than
 * `FRESHNESS_HOURS`, or when the log is unparseable — keeps the diagnose
 * surface tidy until something is actually broken.
 *
 * House style: helpers (`findNpmAdminUrl`, `getNpmToken`) are duplicated
 * from `certExpiry.ts` rather than extracted into a shared module — see
 * the note in `danglingProxy.ts:29`.
 */

import { agentManager } from '@/lib/agent/manager';
import { getConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

const PROBE_ID = 'cert_request_failure';
const FRESHNESS_HOURS = 24;
const TAIL_BYTES = 65_536;

export interface CertRequestFailureResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

interface ParsedFailure {
  domain: string;
  type: string;
  detail: string;
}

export interface ParsedFailureBlock {
  failures: ParsedFailure[];
  rateLimited: boolean;
  /** Newest timestamp anywhere in the tail (epoch ms, UTC-interpreted). */
  ts?: number;
}

function letsencryptLogPath(dataDir: string): string {
  return `${dataDir}/nginx-proxy-manager/data/logs/letsencrypt.log`;
}

// Refuse to compose a shell command unless the path is a clean POSIX
// absolute path. DATA_DIR comes from config and is admin-editable; this
// is belt-and-braces against an accidental shell-meta in the value.
function safePath(p: string): boolean {
  return /^\/[A-Za-z0-9_./-]+$/.test(p);
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

async function readLogTail(node: string, path: string, bytes = TAIL_BYTES): Promise<string | null> {
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

const STRUCTURED_FAILURE_RE = /Domain:\s*(\S+)\s*\n\s*Type:\s*(\S+)\s*\n\s*Detail:\s*([^\n]+)/g;
// Legacy/inline format used by older certbot releases.
const INLINE_FAILURE_RE = /Failed authorization procedure\.\s+(\S+)\s+\(([^)]+)\):\s+urn:ietf:params:acme:error:\S+\s*::\s*([^\n]+)/g;
const RATE_LIMIT_RE = /urn:ietf:params:acme:error:rateLimited/i;
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/gm;

export function parseLetsencryptTail(tail: string): ParsedFailureBlock {
  // Scope to the slice starting at the most recent "Some challenges
  // have failed" line so older failure blocks higher up don't leak in.
  // Failures in certbot output come AFTER the marker line, so we
  // start at the beginning of that line. Fall back to the full tail
  // when the marker isn't present — older log lines sometimes just
  // have "Challenge failed for domain X" without it.
  const lastMarker = tail.lastIndexOf('Some challenges have failed');
  const sliceStart = lastMarker >= 0
    ? Math.max(0, tail.lastIndexOf('\n', lastMarker) + 1)
    : 0;
  const slice = tail.slice(sliceStart);

  const failures: ParsedFailure[] = [];
  STRUCTURED_FAILURE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STRUCTURED_FAILURE_RE.exec(slice)) !== null) {
    failures.push({ domain: m[1].trim(), type: m[2].trim(), detail: m[3].trim() });
  }
  if (failures.length === 0) {
    INLINE_FAILURE_RE.lastIndex = 0;
    while ((m = INLINE_FAILURE_RE.exec(slice)) !== null) {
      failures.push({ domain: m[1].trim(), type: m[2].trim(), detail: m[3].trim() });
    }
  }

  const rateLimited = RATE_LIMIT_RE.test(slice);

  let ts: number | undefined;
  TIMESTAMP_RE.lastIndex = 0;
  const tsMatches = slice.match(TIMESTAMP_RE);
  if (tsMatches && tsMatches.length > 0) {
    const last = tsMatches[tsMatches.length - 1];
    const parsed = Date.parse(`${last.replace(' ', 'T')}Z`);
    if (Number.isFinite(parsed)) ts = parsed;
  }

  return { failures, rateLimited, ts };
}

export async function checkCertRequestFailure(node: string): Promise<CertRequestFailureResult> {
  const config = await getConfig();
  const dataDir = config.templateSettings?.DATA_DIR ?? '/mnt/data';
  const path = letsencryptLogPath(dataDir);

  const tail = await readLogTail(node, path);
  if (tail === null || tail.length === 0) {
    return {
      status: 'info',
      detail: 'No letsencrypt.log found — NPM hasn\'t attempted any cert requests yet.',
    };
  }

  const parsed = parseLetsencryptTail(tail);
  if (parsed.failures.length === 0 && !parsed.rateLimited) {
    return { status: 'ok', detail: 'No Let\'s Encrypt cert failures in the recent NPM log.' };
  }

  if (parsed.ts) {
    const ageMs = Date.now() - parsed.ts;
    if (ageMs > FRESHNESS_HOURS * 3_600_000) {
      return {
        status: 'ok',
        detail: `Last cert failure was ${Math.round(ageMs / 3_600_000)}h ago (outside the ${FRESHNESS_HOURS}h freshness window). Treating as resolved.`,
      };
    }
  }

  // De-duplicate by domain (most recent wins thanks to insertion order).
  const byDomain = new Map<string, ParsedFailure>();
  for (const f of parsed.failures) byDomain.set(f.domain, f);

  const items: ProbeItem[] = [];
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

  return {
    status: 'fail',
    detail: `${items.length} domain${items.length === 1 ? '' : 's'} with recent ACME failure${items.length === 1 ? '' : 's'} in NPM\'s letsencrypt.log.`,
    hint: 'Most common cause is public port 80 not reachable from the internet. Run letsdebug.net for an external view of what the ACME server sees, then click Retry once the underlying cause is fixed.',
    items,
  };
}

// ─── Action handlers ────────────────────────────────────────────────────

async function showLogTail({ node }: { node: string }): Promise<ProbeActionResult> {
  const config = await getConfig();
  const dataDir = config.templateSettings?.DATA_DIR ?? '/mnt/data';
  const path = letsencryptLogPath(dataDir);
  const tail = await readLogTail(node, path, 16_384);
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
