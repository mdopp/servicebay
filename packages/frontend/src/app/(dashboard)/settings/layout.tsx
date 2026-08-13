'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { SettingsProvider, useSettings } from './_lib/SettingsContext';
import { SETTINGS_GROUPS, DEFAULT_GROUP } from './_lib/ia';
import SettingsSearch from './_lib/SettingsSearch';
import { Tabs } from '@/components/ui';

function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '';
  const { saving, loading } = useSettings();
  const activeGroupId = pathname.split('/').filter(Boolean)[1] ?? DEFAULT_GROUP.id;

  if (loading) {
    return <div className="p-8 text-center text-text-subtle">Loading settings...</div>;
  }

  return (
    <div className="h-full overflow-y-auto space-y-6">
      <PageHeader
        title="Settings"
        actions={
          <span className="text-sm text-text-muted inline-flex items-center gap-2">
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
      >
        <SettingsSearch />
      </PageHeader>

      {/* #2549: the shared <Tabs> strip. Nav mode — each group is a routed page,
          so these stay <Link>s with aria-current, not role=tab. The chrome
          (padding, sticky, background) stays here; the primitive owns only the
          tab language, which is now identical to Status'. */}
      <Tabs
        label="Settings groups"
        value={activeGroupId}
        linkComponent={Link}
        className="px-6 bg-surface sticky top-0 z-10"
        items={SETTINGS_GROUPS.map(group => ({
          id: group.id,
          label: group.label,
          icon: group.icon,
          href: `/settings/${group.id}`,
          title: group.intent,
        }))}
      />

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
