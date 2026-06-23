import { headers } from 'next/headers';
import { Settings } from 'lucide-react';
import ServiceBayLogo from '@/components/ServiceBayLogo';
import { getConfig, getAdminBaseUrl } from '@/lib/config';
import { buildPortalCards } from '@/lib/portal/services';
import { isPortalBlockedForRequest } from '@/lib/portal/lanGate';
import { verifyAutheliaSession } from '@/lib/portal/auth';
import PortalGrid from './PortalGrid';
import PortalLogoutLink from './PortalLogoutLink';
import PortalUserChip from './PortalUserChip';
import AccessRequestStatusCTA from './AccessRequestStatusCTA';
import RequestAccessButton from './RequestAccessButton';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * /portal — read-only card grid surfacing every running, feature-tier
 * service that ships a `user-guide.md`. Anonymous-readable per the
 * #242 design conversation, but recognizes signed-in Authelia sessions
 * (#417) to greet the visitor by name and surface a logout affordance.
 * Reachable directly at `/portal` and via the apex/www host rewrite in
 * `proxy.ts`. Same UX in public-domain mode — visitors typing the
 * apex see the family portal regardless of mode.
 *
 * CTA state-machine for anonymous visitors (#1001):
 *   - localStorage-stored access-request id → poll status →
 *       pending  → "Your request is being reviewed" card
 *       resolved → "Welcome! Set your password" card
 *       (otherwise) → default Request-access button
 *   - signed in → no request CTA at all, just the user chip + logout
 *
 * The CTA + status panel sits between the welcome header and the
 * service grid. Anonymous visitors land on it first (the whole point
 * of the page for them is "how do I get access?"), and signed-in
 * visitors don't see it at all so the grid stays the focal point.
 * Pre-#1037 the CTA was after the grid; that pushed the
 * Request-access button below the fold on any portal with more than
 * a handful of cards.
 */
export default async function PortalPage() {
  const hdrs = await headers();
  const config = await getConfig();

  // LAN-only gate (#1456): behind NPM the RSC's TCP peer is always
  // loopback, so passing '127.0.0.1' makes the resolver trust the
  // proxy's X-Real-IP / last-XFF hop (same rule as the MCP gate).
  const headerMap: Record<string, string> = {};
  hdrs.forEach((v, k) => { headerMap[k] = v; });
  if (isPortalBlockedForRequest(config.portalLanOnly, headerMap, '127.0.0.1')) {
    return <PortalLanOnlyNotice />;
  }

  const [cards, visitor] = await Promise.all([
    buildPortalCards('Local'),
    verifyAutheliaSession(hdrs.get('cookie')),
  ]);
  const isLoggedIn = Boolean(visitor.user);
  const displayName = visitor.name?.trim() || visitor.user || null;
  const firstName = displayName?.split(/\s+/)[0] ?? null;
  // Link to the ServiceBay admin dashboard at admin.<domain>. The apex →
  // /portal rewrite otherwise hides any path to the admin UI (#1606). admin.
  // has its own app-layer login (not Authelia forward-auth), so it's safe to
  // surface the link to anyone — the admin login still gates access.
  const adminUrl = getAdminBaseUrl(config);

  return (
    <main className="relative max-w-6xl mx-auto px-space-5 py-space-7">
      {isLoggedIn && displayName && <PortalUserChip displayName={displayName} />}
      <PortalHero isLoggedIn={isLoggedIn} firstName={firstName} adminUrl={adminUrl} />

      {!isLoggedIn && (
        <div className="mb-space-7">
          <AccessRequestStatusCTA fallback={<RequestAccessButton />} />
        </div>
      )}

      {cards.length === 0 ? (
        <div className="text-center text-text-muted py-space-8">
          <p className="text-lg">No services available yet.</p>
          <p className="text-sm mt-space-2 italic">
            (Services appear here once they&apos;re running and a user-guide is shipped with their template.)
          </p>
        </div>
      ) : (
        <PortalGrid cards={cards} />
      )}
    </main>
  );
}

/**
 * Warmer portal hero (#2126): a soft token-driven accent gradient
 * backdrop + a framed box icon + generous spacing so the landing feels
 * inviting, not like a bare list. Carries the welcome line + the
 * admin-dashboard link (separate login). Dark-mode-first, tasteful — no
 * raw colour literals.
 */
function PortalHero({
  isLoggedIn,
  firstName,
  adminUrl,
}: {
  isLoggedIn: boolean;
  firstName: string | null;
  adminUrl: string | null;
}) {
  return (
    <header className="relative mb-space-7 overflow-hidden rounded-panel border border-border bg-gradient-to-b from-accent/10 via-surface to-surface px-space-5 py-space-7 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-48 w-48 rounded-full bg-accent/20 blur-3xl"
      />
      <div className="relative flex items-center justify-center gap-space-3">
        <span className="inline-flex items-center justify-center w-14 h-14 rounded-card bg-accent/15 text-accent shrink-0">
          <ServiceBayLogo size={32} className="shrink-0" />
        </span>
        <h1 className="text-3xl sm:text-4xl font-bold text-text">
          Home <span className="text-text-subtle font-normal">— your family&apos;s private cloud</span>
        </h1>
      </div>
      <p className="relative mt-space-4 text-base text-text-muted">
        {isLoggedIn && firstName
          ? `Welcome back, ${firstName} — pick a service below to get started.`
          : 'Pick a service below to get started.'}
      </p>
      {isLoggedIn && <PortalLogoutLink />}
      {adminUrl && (
        <p className="relative mt-space-4 text-sm text-text-subtle">
          <a
            href={adminUrl}
            className="inline-flex items-center gap-1.5 text-text-muted hover:text-text underline-offset-2 hover:underline"
          >
            <Settings size={14} />
            Admin dashboard
          </a>
          <span className="ml-1.5 text-text-subtle">(separate login)</span>
        </p>
      )}
    </header>
  );
}

/** Shown instead of the portal when `config.portalLanOnly` is on and the
 *  visitor isn't on the home network (#1456). */
function PortalLanOnlyNotice() {
  return (
    <main className="relative max-w-2xl mx-auto px-space-5 py-space-8 text-center">
      <div className="flex items-center justify-center gap-space-3 mb-space-5">
        <ServiceBayLogo size={36} className="text-accent shrink-0" />
        <h1 className="text-3xl font-bold text-text">Home</h1>
      </div>
      <p className="text-lg text-text">
        This page is available on the home network only.
      </p>
      <p className="mt-space-3 text-sm text-text-muted">
        Connect to the home Wi-Fi (or its VPN) and reload to request access or open a service.
      </p>
    </main>
  );
}
