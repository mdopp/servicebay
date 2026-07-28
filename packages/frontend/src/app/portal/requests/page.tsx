import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import ServiceBayLogo from '@/components/ServiceBayLogo';
import { getConfig } from '@/lib/config';
import { isPortalBlockedForRequest } from '@/lib/portal/lanGate';
import { verifyAutheliaSession } from '@/lib/portal/auth';
import AccessRequestStatusCTA from '../AccessRequestStatusCTA';
import PortalLanOnlyNotice from '../PortalLanOnlyNotice';
import RequestAccessDeepLink from './RequestAccessDeepLink';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * `/portal/requests` — the deep-linkable, pre-auth twin of the portal's
 * request-access CTA (#2405). The Solaris companion app points its
 * "Request access" button here (mdopp/solaris-android#50) so a visitor
 * with no account lands **in the form**, not on the portal root one click
 * away from it.
 *
 * Same gates as `/portal`, deliberately reusing the same helpers:
 *   - `isPortalBlockedForRequest` (#1456) — LAN-only gate, same notice.
 *   - `verifyAutheliaSession` (#417) — a signed-in visitor already has an
 *     account, so there is nothing to request: send them to `/portal`
 *     (which greets them by name) rather than showing a dangling form.
 *   - `AccessRequestStatusCTA` (#1001) — a visitor who already submitted
 *     a request sees its pending/resolved status instead of a second
 *     blank form; only the default case opens the form.
 *
 * Reachable pre-auth for the same reason `/portal` is: `proxy.ts` gates
 * `/api/*` and `/napi/*`, not pages. On the apex/www host the rewrite in
 * `proxy.ts` passes `/portal…` paths through untouched, so
 * `https://<domain>/portal/requests` resolves here as well.
 */
export default async function PortalRequestAccessPage() {
  const hdrs = await headers();
  const config = await getConfig();

  // LAN-only gate (#1456): behind NPM the RSC's TCP peer is always
  // loopback, so passing '127.0.0.1' makes the resolver trust the
  // proxy's X-Real-IP / last-XFF hop (same rule as /portal).
  const headerMap: Record<string, string> = {};
  hdrs.forEach((v, k) => { headerMap[k] = v; });
  if (isPortalBlockedForRequest(config.portalLanOnly, headerMap, '127.0.0.1')) {
    return <PortalLanOnlyNotice />;
  }

  const visitor = await verifyAutheliaSession(hdrs.get('cookie'));
  if (visitor.user) redirect('/portal');

  return (
    <main className="relative max-w-2xl mx-auto px-space-5 py-space-8 text-center">
      <div className="flex items-center justify-center gap-space-3 mb-space-5">
        <ServiceBayLogo size={36} className="text-accent shrink-0" />
        <h1 className="text-3xl font-bold text-text">Home</h1>
      </div>
      <p className="text-base text-text-muted">
        Ask the family administrator for your own account.
      </p>

      <AccessRequestStatusCTA fallback={<RequestAccessDeepLink />} />

      <p className="mt-space-7 text-sm">
        <a href="/portal" className="text-text-subtle hover:text-text underline-offset-2 hover:underline">
          Back to Home
        </a>
      </p>
    </main>
  );
}
