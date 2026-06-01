/**
 * `cert_expiry` probe — lists NPM-managed Let's Encrypt certs and
 * flags those expiring within 14 days (warn) or already expired (fail).
 */

import { registerProbe } from './registry';
import { findNpmAdminUrl, getNpmToken } from './npmAdmin';

export const CERT_EXPIRY_MESSAGE_PREFIX = 'cert_expiry:';

interface NpmCert { id: number; provider?: string; domain_names?: string[]; expires_on?: string; }
interface CertItem { id: string; label: string; detail: string; status: 'warn' | 'fail'; actionIds: string[]; }

type Payload = { status: 'ok' | 'warn' | 'fail' | 'info'; detail: string; hint?: string; items?: CertItem[] };

const encode = (payload: Payload) => ({
  status: payload.status === 'fail' ? ('fail' as const) : ('ok' as const),
  message: `${CERT_EXPIRY_MESSAGE_PREFIX}${JSON.stringify(payload)}`,
});

const WARN_DAYS = 14;

function buildCertItems(leCerts: NpmCert[]): { items: CertItem[]; expired: number; expiringSoon: number } {
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
      items.push({ id: String(c.id), label: domains, detail: `EXPIRED ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago — services served via this cert show browser warnings.`, status: 'fail', actionIds: ['renew_cert'] });
    } else if (daysLeft <= WARN_DAYS) {
      expiringSoon += 1;
      items.push({ id: String(c.id), label: domains, detail: `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`, status: 'warn', actionIds: ['renew_cert'] });
    }
  }
  return { items, expired, expiringSoon };
}

registerProbe({
  type: 'cert_expiry',
  async run(check) {
    const node = check.nodeName ?? 'Local';
    try {
      const admin = await findNpmAdminUrl(node);
      if (admin.kind === 'twin-not-ready') return encode({ status: 'info', detail: 'Digital twin not populated yet — check will retry on the next tick.' });
      if (admin.kind === 'nginx-not-found') return encode({ status: 'info', detail: 'Nginx Proxy Manager not deployed — no certificates to check.' });
      const adminUrl = admin.url;
      const token = await getNpmToken(adminUrl);
      if (!token) return encode({ status: 'info', detail: 'Could not authenticate with NPM — skipping certificate check.' });

      let certs: NpmCert[];
      try {
        const res = await fetch(`${adminUrl}/api/nginx/certificates`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return encode({ status: 'info', detail: `NPM certificates API returned HTTP ${res.status}.` });
        certs = (await res.json()) as NpmCert[];
      } catch (e) {
        return encode({ status: 'info', detail: `Could not list NPM certificates: ${e instanceof Error ? e.message : String(e)}` });
      }

      const leCerts = (certs ?? []).filter(c => c.provider === 'letsencrypt');
      if (leCerts.length === 0) return encode({ status: 'info', detail: "No Let's Encrypt certificates managed by NPM." });

      const { items, expired, expiringSoon } = buildCertItems(leCerts);
      if (items.length === 0) {
        return encode({ status: 'ok', detail: `${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'} managed; none expiring in ${WARN_DAYS} days.` });
      }
      const status: 'warn' | 'fail' = expired > 0 ? 'fail' : 'warn';
      return encode({
        status,
        detail: expired > 0
          ? `${expired} expired + ${expiringSoon} expiring soon out of ${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'}.`
          : `${expiringSoon} of ${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'} expiring within ${WARN_DAYS} days.`,
        hint: 'NPM auto-renews on a schedule; click "Renew now" if you want to force a refresh ahead of expiry. Failed renewals usually mean DNS or port-80 challenge changed since issuance.',
        items,
      });
    } catch (e) {
      return { status: 'fail', message: `cert_expiry error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
