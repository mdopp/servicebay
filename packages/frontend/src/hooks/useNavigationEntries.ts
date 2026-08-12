'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import { resolveNavigationEntries, type ResolvedNavigationEntry } from '@/config/navigation';

/**
 * The primary navigation, resolved against live box state (#2521).
 *
 * `Sidebar.tsx` and `MobileNav.tsx` both call this, so they cannot drift
 * apart: whatever the schema resolves to is what both render. It gathers
 * the two runtime inputs the schema's conditional entries need —
 * installed templates (Maintenance Chat) and the LLDAP admin URL (Users &
 * Groups) — plus the active `?node=`, and hands them to the pure
 * `resolveNavigationEntries`.
 *
 * The LLDAP URL is fetched per mounting component, matching how the nav
 * components already fetch `/api/system/version`; the endpoint is a cheap
 * config read and no cross-component fetch cache exists in this app.
 */
export function useNavigationEntries(): ResolvedNavigationEntry[] {
  const searchParams = useSearchParams();
  const node = searchParams?.get('node') ?? null;
  const { data: twin } = useDigitalTwin();
  const [lldapUrl, setLldapUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/lldap-url')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (!cancelled && data?.url) setLldapUrl(data.url); })
      .catch(() => { /* LLDAP not deployed / offline — the entry stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  const installedTemplates = twin?.installedTemplates;
  return useMemo(
    () => resolveNavigationEntries({ installedTemplates, lldapUrl, node }),
    [installedTemplates, lldapUrl, node],
  );
}
