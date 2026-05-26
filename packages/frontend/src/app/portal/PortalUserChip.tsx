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
    <div className="absolute top-6 right-6 flex items-center gap-2 bg-white/80 dark:bg-gray-800/80 backdrop-blur border border-gray-200 dark:border-gray-700 rounded-full pl-2 pr-1 py-1 shadow-sm">
      <div className="shrink-0 w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-700 dark:text-blue-300 font-bold text-xs">
        {initial || <UserIcon size={14} />}
      </div>
      <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 max-w-[10rem] truncate">
        {displayName}
      </span>
      <a
        href={logoutHref}
        className="ml-1 inline-flex items-center justify-center w-7 h-7 rounded-full text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-700/60 transition-colors"
        title="Log out — drops the Authelia session"
        aria-label="Log out"
      >
        <LogOut size={14} />
      </a>
    </div>
  );
}
