/**
 * `cert_expiry` probe — lists NPM-managed Let's Encrypt certs and
 * flags those expiring within 14 days (warn) or already expired (fail).
 *
 * Each flagged cert is also asked one further question (#2594): does any
 * NPM proxy host still use it? NPM keeps certificates and proxy hosts in
 * two independent tables, so removing a route leaves its certificate
 * behind. Such a cert cannot be usefully renewed — a fresh certificate
 * for a domain nothing serves — and the failed ACME run then resurfaces
 * in `cert_request_failure` looking like a new problem. Those rows get
 * `delete_orphaned_cert` instead of `renew_cert`.
 *
 * Why "unbound" alone is NOT the orphan test: a certificate can also be
 * provisioned deliberately *before* its route exists, and offering to
 * delete that one would be worse than the noise this fixes. The test is
 * therefore "unbound AND already inside the expiry window" — and the
 * window is the pre-existing one, unchanged. A Let's Encrypt cert is
 * valid 90 days, so a cert with ≤14 days left has been unused for ~76
 * days; that is an abandoned cert, not one waiting for its route.
 * Outside the window nothing changed at all: an unbound cert is not
 * listed and gets no action offered, exactly as before.
 *
 * The warn/fail thresholds themselves are deliberately untouched here —
 * "expiring soon" stays `ok` at the check level and only an actually
 * expired cert goes red (`encode` below).
 */

import { registerProbe } from './registry';
import { findNpmAdminUrl, getNpmToken, fetchProxyHostBindings, isCertOrphaned, type ProxyHostBindings } from './npmAdmin';

/**
 * The action ids a `cert_expiry` item may carry. Single source of truth:
 * the diagnose twin registers its handlers against these constants, and
 * `certExpiry.test.ts` asserts every id here has one. An id emitted with
 * no handler behind it would otherwise render as a row with no button —
 * `resolveItemActions` drops unknown ids — i.e. an offer that silently
 * cannot be taken.
 */
export const CERT_EXPIRY_ACTION_IDS = {
  renew: 'renew_cert',
  deleteOrphaned: 'delete_orphaned_cert',
} as const;

export type CertExpiryActionId = (typeof CERT_EXPIRY_ACTION_IDS)[keyof typeof CERT_EXPIRY_ACTION_IDS];

interface NpmCert { id: number; provider?: string; domain_names?: string[]; expires_on?: string; }
interface CertItem { id: string; label: string; detail: string; status: 'warn' | 'fail'; actionIds: CertExpiryActionId[]; }

type Payload = { status: 'ok' | 'warn' | 'fail' | 'info'; detail: string; hint?: string; items?: CertItem[] };

const encode = (payload: Payload) => ({
  status: payload.status === 'fail' ? ('fail' as const) : ('ok' as const),
  payload,
});

const WARN_DAYS = 14;

const ORPHAN_HINT =
  ' Certificates marked "no proxy host" belong to no route any more: renewing them would re-issue a certificate nothing serves, and the failed challenge would show up under cert_request_failure. Delete those instead.';

/** Per-row wording. An orphaned row says why renewing is not the move. */
function describeCert(daysLeft: number, orphaned: boolean): string {
  const age = daysLeft < 0
    ? `EXPIRED ${-daysLeft} day${daysLeft === -1 ? '' : 's'} ago`
    : `Expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`;
  if (orphaned) {
    return `${age} — no proxy host uses this certificate any more, so renewing it would serve nothing. Deleting it is what ends the warning.`;
  }
  return daysLeft < 0
    ? `${age} — services served via this cert show browser warnings.`
    : `${age}.`;
}

function buildCertItems(
  leCerts: NpmCert[],
  bindings: ProxyHostBindings | null,
): { items: CertItem[]; expired: number; expiringSoon: number; orphaned: number } {
  const now = Date.now();
  const items: CertItem[] = [];
  let expiringSoon = 0;
  let expired = 0;
  let orphaned = 0;
  for (const c of leCerts) {
    if (!c.expires_on) continue;
    const exp = Date.parse(c.expires_on);
    if (!Number.isFinite(exp)) continue;
    const daysLeft = Math.floor((exp - now) / (1000 * 60 * 60 * 24));
    if (daysLeft > WARN_DAYS) continue;
    const domains = (c.domain_names ?? []).join(', ') || `cert ${c.id}`;
    const isOrphan = isCertOrphaned(c, bindings);
    if (isOrphan) orphaned += 1;
    if (daysLeft < 0) expired += 1;
    else expiringSoon += 1;
    items.push({
      id: String(c.id),
      label: isOrphan ? `${domains} — no proxy host` : domains,
      detail: describeCert(daysLeft, isOrphan),
      status: daysLeft < 0 ? 'fail' : 'warn',
      actionIds: [isOrphan ? CERT_EXPIRY_ACTION_IDS.deleteOrphaned : CERT_EXPIRY_ACTION_IDS.renew],
    });
  }
  return { items, expired, expiringSoon, orphaned };
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

      // null (host list unreadable) → nothing is classified as orphaned
      // and every row keeps `renew_cert`, i.e. the pre-#2594 behaviour.
      const bindings = await fetchProxyHostBindings(adminUrl, token);

      const { items, expired, expiringSoon, orphaned } = buildCertItems(leCerts, bindings);
      if (items.length === 0) {
        return encode({ status: 'ok', detail: `${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'} managed; none expiring in ${WARN_DAYS} days.` });
      }
      const status: 'warn' | 'fail' = expired > 0 ? 'fail' : 'warn';
      const base = expired > 0
        ? `${expired} expired + ${expiringSoon} expiring soon out of ${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'}.`
        : `${expiringSoon} of ${leCerts.length} Let's Encrypt cert${leCerts.length === 1 ? '' : 's'} expiring within ${WARN_DAYS} days.`;
      return encode({
        status,
        detail: orphaned > 0
          ? `${base} ${orphaned} of them belong to no proxy host any more.`
          : base,
        hint: 'NPM auto-renews on a schedule; click "Renew now" if you want to force a refresh ahead of expiry. Failed renewals usually mean DNS or port-80 challenge changed since issuance.'
          + (orphaned > 0 ? ORPHAN_HINT : ''),
        items,
      });
    } catch (e) {
      return { status: 'fail', message: `cert_expiry error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
});
