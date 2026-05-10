import { notFound } from 'next/navigation';
import { getConfig } from '@/lib/config';
import { getMode } from '@/lib/mode';
import { buildPortalCards } from '@/lib/portal/services';
import PortalGrid from './PortalGrid';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

/**
 * /portal — read-only card grid surfacing every running, feature-tier
 * service that ships a `user-guide.md`. Anonymous in LAN mode (per
 * the design conversation in #242); 404 in public mode until #265's
 * soft-handoff lands and we can decide how to expose it outside the
 * LAN safely.
 */
export default async function PortalPage() {
  const config = await getConfig();
  const mode = getMode(config);
  if (mode === 'public') {
    // Don't expose the portal on a public hostname — every service
    // already has its own auth-gated URL there. Public-mode portal
    // exposure needs its own design pass (filed alongside #265).
    notFound();
  }

  const cards = await buildPortalCards('Local');

  return (
    <main className="max-w-6xl mx-auto px-6 py-12">
      <header className="mb-10 text-center">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
          🏠 Home — your family&apos;s private cloud
        </h1>
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
    </main>
  );
}
