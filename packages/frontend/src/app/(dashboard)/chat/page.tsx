'use client';

/**
 * Maintenance chat route (#1755 / epic #1704; embed migration servicebay#1781).
 *
 * Hosts an embed of solilos-chat (`MaintenanceChatEmbed`) behind the standard
 * dashboard chrome, scoped to the server-enforced maintenance persona. The
 * Sidebar only shows the link when `installedTemplates` contains
 * `solilos-chat` (the iframe target); if an operator reaches the route directly
 * on a box without it, we show a calm "not installed" notice instead of a dead
 * frame.
 */

import PageHeader from '@/components/PageHeader';
import MaintenanceChatEmbed from '@/components/MaintenanceChatEmbed';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';

export default function ChatPage() {
  const { data } = useDigitalTwin();
  // `installedTemplates` is undefined until the first twin snapshot arrives;
  // treat undefined as "still loading" (show the embed) and only show the
  // not-installed notice once we have a snapshot that lacks solilos-chat.
  const templates = data?.installedTemplates;
  const chatInstalled = !templates || templates.includes('solilos-chat');

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Maintenance Chat" showBack={false} />
      {chatInstalled ? (
        <div className="flex-1 min-h-0">
          <MaintenanceChatEmbed />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 text-center text-gray-500 dark:text-gray-400">
          <p className="max-w-sm">
            The Solilos chat is not installed on this server. Install the
            Solilos assistant to chat with the maintenance assistant.
          </p>
        </div>
      )}
    </div>
  );
}
