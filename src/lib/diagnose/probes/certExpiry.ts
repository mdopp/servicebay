/**
 * `cert_expiry` probe — surfaces NPM-managed Let's Encrypt certificates
 * that are expiring soon (≤14 days = warn) or already expired (fail).
 * Each item gets a per-row "Renew now" action that triggers NPM's
 * cert renewal endpoint.
 *
 * Silent (status: info) in LAN-domain mode where no certs exist —
 * keeps the diagnose surface tidy until the operator switches to
 * public-domain mode (D19-PR8 / #265). Also silent on the cold path
 * (no NPM, no creds, no response) — the existing pods / npm_data_stale
 * probes already cover those cases.
 */

import { getConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { logger } from '@/lib/logger';
import { registerProbeAction, type ProbeActionResult, type ProbeItem } from '../actions';

const PROBE_ID = 'cert_expiry';
const WARN_DAYS = 14;

export interface CertExpiryResult {
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  hint?: string;
  items?: ProbeItem[];
}

interface NpmCert {
  id: number;
  provider?: string;
  nice_name?: string;
  domain_names?: string[];
  expires_on?: string;
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

export async function checkCertExpiry(node: string): Promise<CertExpiryResult> {
  const adminUrl = await findNpmAdminUrl(node);
  if (!adminUrl) {
    return { status: 'info', detail: 'Nginx Proxy Manager not deployed — no certificates to check.' };
  }
  const token = await getNpmToken(adminUrl);
  if (!token) {
    return { status: 'info', detail: 'Could not authenticate with NPM — skipping certificate check.' };
  }
  let certs: NpmCert[];
  try {
    const res = await fetch(`${adminUrl}/api/nginx/certificates`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      return { status: 'info', detail: `NPM certificates API returned HTTP ${res.status}.` };
    }
    certs = await res.json() as NpmCert[];
  } catch (e) {
    return { status: 'info', detail: `Could not list NPM certificates: ${e instanceof Error ? e.message : String(e)}` };
  }

  // NPM tracks self-uploaded certs too; the diagnose value is in
  // letsencrypt-managed ones (NPM auto-renews them but renewal can
  // fail silently — DNS challenge regression, rate limit, etc).
  const leCerts = (certs ?? []).filter(c => c.provider === 'letsencrypt');
  if (leCerts.length === 0) {
    return { status: 'info', detail: 'No Let\'s Encrypt certificates managed by NPM.' };
  }
  const now = Date.now();
  const items: ProbeItem[] = [];
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
    return {
      status: 'ok',
      detail: `${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'} managed; none expiring in ${WARN_DAYS} days.`,
    };
  }
  const status: 'warn' | 'fail' = expired > 0 ? 'fail' : 'warn';
  return {
    status,
    detail: expired > 0
      ? `${expired} expired + ${expiringSoon} expiring soon out of ${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'}.`
      : `${expiringSoon} of ${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'} expiring within ${WARN_DAYS} days.`,
    hint: 'NPM auto-renews on a schedule; click "Renew now" if you want to force a refresh ahead of expiry. Failed renewals usually mean DNS or port-80 challenge changed since issuance.',
    items,
  };
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
        message: `NPM returned HTTP ${res.status}. Check NPM admin → SSL Certificates for the underlying error (most common: DNS challenge regression or port-80 unreachable).`,
        refresh: false,
      };
    }
    return {
      ok: true,
      message: `Renewal triggered for cert ${itemId}. NPM may take 30-60 s to complete the ACME challenge.`,
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
