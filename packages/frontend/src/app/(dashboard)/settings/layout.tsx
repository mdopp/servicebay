'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { SettingsProvider, useSettings } from './_lib/SettingsContext';
import { SETTINGS_GROUPS, DEFAULT_GROUP } from './_lib/ia';
import SettingsSearch from './_lib/SettingsSearch';
import { Tabs } from '@/components/ui';

/** Header + group tabs. Rendered only once the config is in. */
function SettingsChrome({ activeGroupId, saving }: { activeGroupId: string; saving: boolean }) {
  return (
    <>
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
    </>
  );
}

function SettingsShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || '';
  const { saving, loading } = useSettings();
  const activeGroupId = pathname.split('/').filter(Boolean)[1] ?? DEFAULT_GROUP.id;

  // #2555: the chrome is swapped for a loading line while the config loads, but
  // `{children}` — the routed page segment — MUST stay mounted at a stable
  // position in the tree the whole time. It used to sit behind an
  // `if (loading) return <…>` early exit, so the page was dropped from the tree
  // on the first render and re-added once the fetch resolved. For a page that is
  // a server-side `redirect()` that delivers the redirect LATE, after the client
  // router has already settled, and Next resolves it as a hard (MPA) navigation.
  // Next's own <Router> bails out of render early in that state
  // (`throw unresolvedThenable`, before several of its later hooks), so the next
  // render calls more hooks and React kills the page with "Rendered more hooks
  // than during the previous render". Hiding the page instead of unmounting it
  // keeps a late-arriving redirect on the initial render pass, where the router
  // handles it as an ordinary navigation. (The three Settings redirect routes
  // themselves are `next.config.ts` redirects now — see the note there.)
  return (
    <div className="h-full overflow-y-auto space-y-6">
      {loading ? (
        <div className="p-8 text-center text-text-subtle">Loading settings...</div>
      ) : (
        <SettingsChrome activeGroupId={activeGroupId} saving={saving} />
      )}

      <div
        data-testid="settings-page-slot"
        className={loading ? 'hidden' : 'px-4 pb-8 w-full space-y-6'}
      >
        {children}
      </div>
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
