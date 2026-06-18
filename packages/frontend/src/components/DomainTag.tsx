'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Globe, Home } from 'lucide-react';
import { useSystemMode } from '@/hooks/useSystemMode';

interface DomainTagProps {
  /**
   * Signed-in username. Pass it when the caller already has it (the
   * Sidebar fetches /api/auth/me for its user chip). Omit it and the
   * tag fetches /api/auth/me itself (the mobile top bar has no user
   * state of its own). `null` = known-not-signed-in → show the bare
   * domain without the "<user> on" prefix.
   */
  username?: string | null;
  /** Sidebar collapsed rail — render the icon only, with a tooltip. */
  collapsed?: boolean;
}

// Self-fetch the signed-in username from /api/auth/me when the caller
// didn't supply one (the mobile top bar has no user state of its own).
// `undefined` prop → fetch; an explicit value (incl. null) is honoured.
function useResolvedUsername(supplied: string | null | undefined): string | null {
  const [selfUser, setSelfUser] = useState<string | null>(null);
  const needsSelfFetch = supplied === undefined;
  useEffect(() => {
    if (!needsSelfFetch) return;
    let cancelled = false;
    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d?.authenticated && d.username) setSelfUser(d.username as string); })
      .catch(() => { /* non-essential */ });
    return () => { cancelled = true; };
  }, [needsSelfFetch]);
  return needsSelfFetch ? selfUser : supplied;
}

/**
 * Where this ServiceBay lives, shown near the signed-in user (#249,
 * relocated out of the page header). Reads the install mode via
 * {@link useSystemMode}:
 *
 *  - 🌍 public mode — "<user> on <publicDomain>", informational.
 *  - 🏡 LAN mode — "<user> on <lanDomain>" + an "add a public
 *    domain →" affordance linking to Settings → Reverse Proxy.
 *
 * Renders nothing until the mode lands (non-essential chrome).
 */
export default function DomainTag({ username, collapsed = false }: DomainTagProps) {
  const mode = useSystemMode();
  const user = useResolvedUsername(username);

  if (!mode) return null;
  const isPublic = mode.mode === 'public' && !!mode.publicDomain;
  const domain = isPublic ? mode.publicDomain! : mode.activeDomain;
  const Icon = isPublic ? Globe : Home;
  const tone = isPublic
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-amber-600 dark:text-amber-400';
  const tooltip = isPublic
    ? `Public domain mode — services reachable at <sub>.${domain} with HTTPS + external access.`
    : `Internal-only mode — services reachable at <sub>.${domain} on the LAN, no HTTPS / external access. Click to add a public domain.`;

  if (collapsed) {
    return (
      <div className="flex justify-center py-1" title={`${user ? `${user} on ` : ''}${domain}\n${tooltip}`}>
        <Icon size={16} className={`shrink-0 ${tone}`} />
      </div>
    );
  }

  const line = (
    <div className="flex items-center gap-1.5 min-w-0" title={tooltip}>
      <Icon size={13} className={`shrink-0 ${tone}`} />
      <span className="truncate text-xs text-gray-500 dark:text-gray-400">
        {user && <span className="font-semibold text-gray-700 dark:text-gray-300">{user}</span>}
        {user ? ' on ' : ''}
        <span className="font-semibold text-gray-700 dark:text-gray-300">{domain}</span>
      </span>
    </div>
  );

  // LAN mode keeps the "upgrade to a public domain" affordance.
  if (!isPublic) {
    return (
      <div className="flex flex-col gap-0.5 min-w-0">
        {line}
        <Link
          href="/settings/network-domain#reverse-proxy"
          className="text-[11px] font-medium text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors truncate"
        >
          + add a public domain →
        </Link>
      </div>
    );
  }

  return line;
}
