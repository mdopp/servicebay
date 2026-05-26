import { headers } from 'next/headers';
import ServiceBayLogo from '@/components/ServiceBayLogo';
import { buildPortalCards } from '@/lib/portal/services';
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
 */
export default async function PortalPage() {
  const hdrs = await headers();
  const [cards, visitor] = await Promise.all([
    buildPortalCards('Local'),
    verifyAutheliaSession(hdrs.get('cookie')),
  ]);
  const isLoggedIn = Boolean(visitor.user);
  const displayName = visitor.name?.trim() || visitor.user || null;
  const firstName = displayName?.split(/\s+/)[0] ?? null;

  return (
    <main className="relative max-w-6xl mx-auto px-6 py-12">
      {isLoggedIn && displayName && <PortalUserChip displayName={displayName} />}
      <header className="mb-10 text-center">
        <div className="flex items-center justify-center gap-3">
          <ServiceBayLogo size={36} className="text-blue-600 dark:text-blue-400 shrink-0" />
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
            Home <span className="text-gray-400 dark:text-gray-600 font-normal">— your family&apos;s private cloud</span>
          </h1>
        </div>
        <p className="mt-3 text-base text-gray-600 dark:text-gray-400">
          {isLoggedIn && firstName
            ? `Welcome back, ${firstName} — pick a service below to get started.`
            : 'Pick a service below to get started.'}
        </p>
        {isLoggedIn && <PortalLogoutLink />}
      </header>

      {cards.length === 0 ? (
        <div className="text-center text-gray-500 dark:text-gray-400 py-16">
          <p className="text-lg">No services available yet.</p>
          <p className="text-sm mt-2 italic">
            (Services appear here once they&apos;re running and a user-guide is shipped with their template.)
          </p>
        </div>
      ) : (
        <PortalGrid cards={cards} />
      )}

      {!isLoggedIn && (
        <AccessRequestStatusCTA fallback={<RequestAccessButton />} />
      )}
    </main>
  );
}
