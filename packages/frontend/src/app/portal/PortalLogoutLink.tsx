'use client';

import { useSyncExternalStore } from 'react';
import { LogOut } from 'lucide-react';

/**
 * "Log out" link on /portal for signed-in visitors (#1001).
 *
 * Mirrors the sidebar logout flow from Sidebar.tsx: parse the apex
 * from window.location.host, redirect to https://auth.<apex>/logout.
 * Falls back to a bare /portal href when we can't derive the apex
 * (raw IP, single-label host) — the operator can still hit
 * auth.<domain>/logout by hand.
 *
 * useSyncExternalStore (with a no-op subscribe) is the pattern used
 * elsewhere in /portal to read the window.location at render time
 * without a setState-in-effect cascade — see useIsIOS in PortalGrid.
 */
const noopSubscribe = () => () => {};

function derive(): string {
  const host = window.location.host;
  const dotIdx = host.indexOf('.');
  if (dotIdx < 0) return '/portal';
  return `https://auth${host.slice(dotIdx)}/logout`;
}

export default function PortalLogoutLink() {
  const href = useSyncExternalStore(noopSubscribe, derive, () => '/portal');
  return (
    <div className="mt-space-4">
      <a
        href={href}
        className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text"
      >
        <LogOut size={14} />
        Log out
      </a>
    </div>
  );
}
