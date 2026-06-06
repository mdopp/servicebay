'use client';

/**
 * Maintenance chat route (#1755, part B of epic #1704).
 *
 * Hosts the native HermesChatPanel behind the standard dashboard chrome.
 * The entry is gated on `hermes` being installed (the Sidebar only shows the
 * link when `installedTemplates` contains `hermes`); if an operator reaches
 * the route directly on a box without Hermes, we show a calm "not installed"
 * notice instead of a dead chat box.
 */

import PageHeader from '@/components/PageHeader';
import HermesChatPanel from '@/components/HermesChatPanel';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';

export default function ChatPage() {
  const { data } = useDigitalTwin();
  // `installedTemplates` is undefined until the first twin snapshot arrives;
  // treat undefined as "still loading" (show the panel) and only show the
  // not-installed notice once we have a snapshot that lacks hermes.
  const templates = data?.installedTemplates;
  const hermesInstalled = !templates || templates.includes('hermes');

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Maintenance Chat" showBack={false} />
      {hermesInstalled ? (
        <div className="flex-1 min-h-0">
          <HermesChatPanel />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 text-center text-gray-500 dark:text-gray-400">
          <p className="max-w-sm">
            The Hermes assistant is not installed on this server. Install the
            Hermes service to chat with the maintenance assistant.
          </p>
        </div>
      )}
    </div>
  );
}
