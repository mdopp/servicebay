'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Home, Globe } from 'lucide-react';

interface ModeInfo {
  mode: 'lan' | 'public';
  activeDomain: string;
  publicDomain: string | null;
  lanDomain: string | null;
}

/**
 * Persistent header badge showing the install mode (#249).
 *
 *  - 🌍 in `public` mode — shows the public domain.
 *  - 🏡 in `lan` mode — shows "Internal only · home.arpa" with a link
 *    to Settings → Reverse Proxy to upgrade.
 *
 * Reads `/api/system/mode` once on mount. Cheap (no agent calls).
 * Renders nothing while loading.
 */
export default function ModeBadge() {
  const [info, setInfo] = useState<ModeInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system/mode')
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (!cancelled && data) setInfo(data as ModeInfo); })
      .catch(() => { /* badge is non-essential — silently skip on error */ });
    return () => { cancelled = true; };
  }, []);

  if (!info) return null;

  if (info.mode === 'public' && info.publicDomain) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
        title={`Public domain mode — services reachable at <sub>.${info.publicDomain} with HTTPS + external access.`}
      >
        <Globe size={11} />
        <span className="hidden sm:inline">{info.publicDomain}</span>
      </span>
    );
  }

  // LAN mode — services live on home.arpa via AdGuard rewrites.
  return (
    <Link
      href="/settings#reverse-proxy"
      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/30 transition-colors"
      title={`Internal-only mode — services reachable at <sub>.${info.activeDomain} on the LAN, no HTTPS / external access. Click to add a public domain.`}
    >
      <Home size={11} />
      <span className="hidden sm:inline">Internal · {info.activeDomain}</span>
      <span className="hidden md:inline ml-1 opacity-70">+ public domain →</span>
    </Link>
  );
}
