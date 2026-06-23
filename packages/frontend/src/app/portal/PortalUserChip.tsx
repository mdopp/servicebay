'use client';

import { useSyncExternalStore } from 'react';
import { LogOut, User as UserIcon } from 'lucide-react';

/**
 * Top-right signed-in indicator for the family portal (#1001).
 *
 * Mirrors the sidebar chip + Logout pattern in Sidebar.tsx — avatar
 * with the displayName's first initial (UserIcon fallback when the
 * name is empty), the name itself, and a Logout link that derives
 * the Authelia URL from window.location.host.
 *
 * Rendered only when `displayName` is truthy. The visitor side of
 * /portal (no session) gets the AccessRequestStatusCTA + Request-
 * access button instead.
 *
 * useSyncExternalStore with a no-op subscribe is the same pattern
 * PortalLogoutLink and PortalGrid use to read window state at render
 * time without a setState-in-effect cascade.
 */

const noopSubscribe = () => () => {};

function deriveLogoutHref(): string {
  const host = window.location.host;
  const dotIdx = host.indexOf('.');
  if (dotIdx < 0) return '/portal';
  return `https://auth${host.slice(dotIdx)}/logout`;
}

export default function PortalUserChip({ displayName }: { displayName: string }) {
  const logoutHref = useSyncExternalStore(noopSubscribe, deriveLogoutHref, () => '/portal');
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div className="absolute top-space-5 right-space-5 flex items-center gap-space-2 bg-surface/80 backdrop-blur border border-border rounded-full pl-2 pr-1 py-1 shadow-sm">
      <div className="shrink-0 w-7 h-7 rounded-full bg-accent/15 flex items-center justify-center text-accent font-bold text-xs">
        {initial || <UserIcon size={14} />}
      </div>
      <span className="text-sm font-semibold text-text max-w-[10rem] truncate">
        {displayName}
      </span>
      <a
        href={logoutHref}
        className="ml-1 inline-flex items-center justify-center w-7 h-7 rounded-full text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
        title="Log out — drops the Authelia session"
        aria-label="Log out"
      >
        <LogOut size={14} />
      </a>
    </div>
  );
}
