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
 * only the detection moved into the health subsystem. `delete_orphaned_cert`
 * (#2594) is its counterpart for a certificate no proxy host uses any
 * more, where renewing is the wrong direction entirely.
 *
 * Both handlers re-derive the binding state from NPM before they act.
 * The item list they were clicked from is up to an hour old, and the two
 * actions point opposite ways — so neither is allowed to run on the
 * strength of a stale row.
 */

import { logger } from '@/lib/logger';
import { findNpmAdmin, getNpmToken } from '@/lib/npm/client';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';
import { HealthStore } from '@/lib/health/store';
import { CERT_EXPIRY_ACTION_IDS } from '@/lib/health/probes/certExpiry';
import { classifyCertBinding } from '@/lib/health/probes/npmAdmin';
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

/** Shared preamble for both cert actions: validate the id, locate NPM,
 *  authenticate. Returns either the refusal to hand straight back to the
 *  UI or the session both handlers need. */
async function openNpmSession(
  node: string,
  itemId: string | undefined,
): Promise<{ ok: false; result: ProbeActionResult } | { ok: true; adminUrl: string; token: string }> {
  if (!itemId) return { ok: false, result: { ok: false, message: 'No certificate id supplied.', refresh: false } };
  // NPM cert IDs come from the API and are numeric — guard for safety
  // even though the dispatcher already validates the request body.
  if (!/^\d+$/.test(itemId)) {
    return { ok: false, result: { ok: false, message: `Certificate id "${itemId}" doesn't look numeric.`, refresh: false } };
  }
  // requireActive: false — the twin's `active` flag lies for the kube nginx
  // pod (#496); the certificate lookup below is the real check.
  const adminUrl = (await findNpmAdmin({ node, requireActive: false }))?.apiUrl;
  if (!adminUrl) {
    return { ok: false, result: { ok: false, message: 'Nginx Proxy Manager is not deployed on this node.', refresh: false } };
  }
  const token = await getNpmToken(adminUrl);
  if (!token) {
    return {
      ok: false,
      result: {
        ok: false,
        message: 'Could not authenticate with NPM — fix the npm_data_stale probe first.',
        refresh: false,
      },
    };
  }
  return { ok: true, adminUrl, token };
}

const describeDomains = (domains: string[], itemId: string) => domains.join(', ') || `certificate ${itemId}`;

async function renewCert({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  const session = await openNpmSession(node, itemId);
  if (!session.ok) return session.result;
  const { adminUrl, token } = session;
  const id = itemId as string;
  // Refuse up front rather than burn an ACME attempt that cannot
  // succeed: without a proxy host the challenge has nowhere to land,
  // the failure resurfaces under cert_request_failure as if it were a
  // new problem, and repeated tries count against Let's Encrypt's
  // rate limit. `unknown` (NPM unreadable) still renews — same-as-before
  // behaviour, and a pointless renewal is only noise.
  const binding = await classifyCertBinding(adminUrl, token, id);
  if (binding.kind === 'orphaned') {
    return {
      ok: false,
      message: `Nothing is served from ${describeDomains(binding.domains, id)} any more — no NPM proxy host uses this certificate, so a renewal has no route to prove ownership over and would fail. "Delete certificate" is the action that resolves this row.`,
      refresh: true,
    };
  }
  return performRenew(adminUrl, token, id);
}

async function performRenew(adminUrl: string, token: string, itemId: string): Promise<ProbeActionResult> {
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

/** Delete a certificate that no proxy host uses any more (#2594).
 *  Never acts on the row alone: NPM is asked again, and anything other
 *  than a confirmed "orphaned" refuses. `unknown` refuses too — a
 *  wrongly-skipped delete leaves a warning, a wrongly-performed one
 *  takes TLS off a live site. */
async function deleteOrphanedCert({
  node,
  itemId,
}: {
  node: string;
  itemId?: string;
}): Promise<ProbeActionResult> {
  const session = await openNpmSession(node, itemId);
  if (!session.ok) return session.result;
  const { adminUrl, token } = session;
  const id = itemId as string;
  const binding = await classifyCertBinding(adminUrl, token, id);
  if (binding.kind === 'unknown') {
    return { ok: false, message: `Not deleting: ${binding.reason} Nothing was changed — re-run the check and try again.`, refresh: true };
  }
  if (binding.kind === 'in-use') {
    return {
      ok: false,
      message: `Not deleting: an NPM proxy host still uses this certificate (${describeDomains(binding.domains, id)}). Deleting it would drop TLS for that route. Renew it instead.`,
      refresh: true,
    };
  }
  return performCertDelete(adminUrl, token, id, binding.domains);
}

async function performCertDelete(
  adminUrl: string,
  token: string,
  itemId: string,
  domains: string[],
): Promise<ProbeActionResult> {
  try {
    const res = await fetch(`${adminUrl}/api/nginx/certificates/${itemId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('diagnose:cert_expiry', `DELETE cert id=${itemId} returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      return {
        ok: false,
        message: `NPM returned HTTP ${res.status} when deleting certificate ${itemId}.`,
        refresh: false,
      };
    }
    return {
      ok: true,
      message: `Certificate for ${describeDomains(domains, itemId)} deleted. It served no route, so nothing goes offline; adding the domain back later requests a fresh certificate.`,
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
    id: CERT_EXPIRY_ACTION_IDS.deleteOrphaned,
    label: 'Delete certificate',
    description:
      'Removes this certificate from Nginx Proxy Manager. It is offered only for a certificate no proxy host uses any more, and the check is repeated against NPM before anything is deleted — if a route has been created for it in the meantime, the deletion is refused. Nothing goes offline; re-adding the domain later requests a fresh certificate.',
    destructive: true,
  },
  deleteOrphanedCert,
);

registerProbeAction(
  PROBE_ID,
  {
    id: CERT_EXPIRY_ACTION_IDS.renew,
    label: 'Renew now',
    description:
      'Triggers NPM\'s ACME renewal endpoint for this certificate. Usually completes in 30-60 s; the underlying ACME challenge runs against Let\'s Encrypt and re-fetches a fresh cert.',
  },
  renewCert,
);

registerRefreshNow(PROBE_ID, CHECK_ID, 'Cert expiry');
