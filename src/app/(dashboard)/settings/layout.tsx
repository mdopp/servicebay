'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Database, Layers, Loader2, Plug, Server, Settings } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { SettingsProvider, useSettings } from './_lib/SettingsContext';

const TABS = [
  { id: 'nodes', label: 'Nodes', icon: Server },
  { id: 'stacks', label: 'Stacks', icon: Layers },
  { id: 'system', label: 'System', icon: Settings },
  { id: 'integrations', label: 'Integrations', icon: Plug },
  { id: 'backups', label: 'Backups', icon: Database },
] as const;

function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '';
  const { saving, loading } = useSettings();
  const activeTab = pathname.split('/').filter(Boolean)[1] ?? 'nodes';

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading settings...</div>;
  }

  return (
    <div className="h-full overflow-y-auto space-y-6">
      <PageHeader
        title="Settings"
        actions={
          <span className="text-sm text-gray-500 dark:text-gray-400 inline-flex items-center gap-2">
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving changes…
              </>
            ) : (
              'All changes saved'
            )}
          </span>
        }
      />

      <div className="flex border-b border-gray-200 dark:border-gray-700 px-6 bg-white dark:bg-gray-900 sticky top-0 z-10 overflow-x-auto">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <Link
              key={tab.id}
              href={`/settings/${tab.id}`}
              className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                isActive
                  ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300'
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </Link>
          );
        })}
      </div>

      <div className="px-4 pb-8 w-full space-y-6">{children}</div>
    </div>
  );
}

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SettingsProvider>
      <SettingsShell>{children}</SettingsShell>
    </SettingsProvider>
  );
}
