import ServiceBayLogo from '@/components/ServiceBayLogo';
import { buildPortalCards } from '@/lib/portal/services';
import PortalGrid from './PortalGrid';
import RequestAccessButton from './RequestAccessButton';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * /portal — read-only card grid surfacing every running, feature-tier
 * service that ships a `user-guide.md`. Anonymous on the LAN per the
 * #242 design conversation. Reachable directly at `/portal` and via
 * the apex/www host rewrite in `proxy.ts`. Same UX in public-domain
 * mode — visitors typing the apex see the family portal regardless
 * of mode.
 */
export default async function PortalPage() {
  const cards = await buildPortalCards('Local');

  return (
    <main className="max-w-6xl mx-auto px-6 py-12">
      <header className="mb-10 text-center">
        <div className="flex items-center justify-center gap-3">
          <ServiceBayLogo size={36} className="text-violet-600 dark:text-violet-400 shrink-0" />
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
            Home <span className="text-gray-400 dark:text-gray-600 font-normal">— your family&apos;s private cloud</span>
          </h1>
        </div>
        <p className="mt-3 text-base text-gray-600 dark:text-gray-400">
          Pick a service below to get started.
        </p>
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

      <RequestAccessButton />
    </main>
  );
}
