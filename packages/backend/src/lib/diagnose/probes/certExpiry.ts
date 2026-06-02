/**
 * `cert_expiry` probe — surfaces NPM-managed Let's Encrypt certificates
 * that are expiring soon (≤14 days = warn) or already expired (fail).
 * Each item gets a per-row "Renew now" action that triggers NPM's
 * cert renewal endpoint.
 *
 * Phase 3b of the diagnose / health-check rework (#484): this probe
 * is now a **thin reader** over the health-check subsystem. Detection
 * runs on a `cert_expiry`-type singleton check (1 h interval, see
 * `health/init.ts`) and the result is persisted to `HealthStore`.
 * Result persistence, scheduling, and the Phase 3a SSE broadcast all
 * live there — this file just reads the latest result back into the
 * diagnose narrative.
 *
 * The `renew_cert` action handler stays here because it mutates NPM
 * state at click-time (re-runs the ACME challenge for one cert id) —
 * only the detection moved into the health subsystem.
 */

import { getConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';
import { HealthStore } from '@/lib/health/store';
import { registerRefreshNow } from './refreshHealthCheck';

const PROBE_ID = 'cert_expiry';
const CHECK_ID = 'cert_expiry';

export interface CertExpiryResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

/** Reader: surfaces the latest persisted `cert_expiry` health-check
 *  result. Items carry the numeric NPM cert id encoded by the runner;
 *  `renew_cert` decodes it back to a `/api/nginx/certificates/<id>/renew`
 *  POST against NPM.  Diagnose route used to call this with
 *  `(nodeName)` — the arg is now unused because the singleton check
 *  captures the node via its `nodeName` field. */
export async function checkCertExpiry(): Promise<CertExpiryResult> {
  const result = HealthStore.getLastResult(CHECK_ID);
  if (!result) {
    // #664 — S4: distinguish missing-prereq from pending-schedule.
    // The cert_expiry check exists once at least one proxy host with
    // a public exposure is recorded (NPM has certs to inspect).
    const exists = HealthStore.getChecks().some(c => c.id === CHECK_ID);
    if (!exists) {
      return {
        status: 'info',
        detail: 'No proxy hosts with public exposure recorded yet — nothing to check expiry on. Add a public domain in the wizard or Settings → Reverse Proxy.',
      };
    }
    return {
      status: 'info',
      detail: 'Scheduled — first run pending. Open Settings → Health to trigger it manually.',
    };
  }
  const parsed = result.payload as
    | { status?: unknown; detail?: unknown; hint?: unknown; items?: unknown }
    | undefined;
  if (parsed && typeof parsed.status === 'string' && typeof parsed.detail === 'string') {
    return {
      status: parsed.status as CertExpiryResult['status'],
      detail: parsed.detail,
      hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
      items: Array.isArray(parsed.items) ? (parsed.items as ProbeItem[]) : undefined,
    };
  }
  if (result.status === 'fail') {
    return {
      status: 'info',
      detail: `Check failed to run: ${result.message || 'unknown error'}`,
    };
  }
  return { status: 'info', detail: 'Cert expiry check produced no actionable signal.' };
}

// ─── Action handlers (kept in the probe file) ───────────────────────────

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

async function renewCert({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  if (!itemId) return { ok: false, message: 'No certificate id supplied.', refresh: false };
  // NPM cert IDs come from the API and are numeric — guard for safety
  // even though the dispatcher already validates the request body.
  if (!/^\d+$/.test(itemId)) {
    return { ok: false, message: `Certificate id "${itemId}" doesn't look numeric.`, refresh: false };
  }
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) return { ok: false, message: 'Nginx Proxy Manager is not deployed on this node.', refresh: false };
  const token = await getNpmToken(adminUrl);
  if (!token) {
    return {
      ok: false,
      message: 'Could not authenticate with NPM — fix the npm_data_stale probe first.',
      refresh: false,
    };
  }
  try {
    const res = await fetch(`${adminUrl}/api/nginx/certificates/${itemId}/renew`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('diagnose:cert_expiry', `Renew id=${itemId} returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      return {
        ok: false,
        message: `NPM returned HTTP ${res.status}. The cert_request_failure probe shows the certbot log tail with the categorised cause (port-80 / DNS / CAA / rate-limit).`,
        refresh: false,
      };
    }
    // Concrete next-step + visible timestamp: the operator should know
    // exactly when the renewal was kicked off and where to look for
    // the result. cert_expiry sweeps hourly; the Refresh-now action
    // short-circuits the wait when needed.
    const triggeredAt = new Date().toISOString().replace('T', ' ').replace(/\..+/, ' UTC');
    return {
      ok: true,
      message: `Renewal triggered for cert ${itemId} at ${triggeredAt}. ACME usually completes in 30-60 s — click "Refresh now" or wait for the next hourly cert_expiry sweep to see the new expiry date.`,
      refresh: true,
    };
  } catch (e) {
    return {
      ok: false,
      message: `Could not reach NPM: ${e instanceof Error ? e.message : String(e)}`,
      refresh: false,
    };
  }
}

registerProbeAction(
  PROBE_ID,
  {
    id: 'renew_cert',
    label: 'Renew now',
    description:
      'Triggers NPM\'s ACME renewal endpoint for this certificate. Usually completes in 30-60 s; the underlying ACME challenge runs against Let\'s Encrypt and re-fetches a fresh cert.',
  },
  renewCert,
);

registerRefreshNow(PROBE_ID, CHECK_ID, 'Cert expiry');
