'use client';

import { useEffect, useState } from 'react';
import { Home } from 'lucide-react';

/**
 * Persistent header badge that surfaces "Local-only mode" — the install
 * has no public domain configured, so services run on local IP:port,
 * SSO is off, and the reverse-proxy / OIDC paths are skipped. Without
 * this badge users can spend a confused minute wondering why their
 * `https://photos.<domain>` link doesn't work; with it the answer is
 * one glance away.
 *
 * Reads `/api/system/mode` once on mount. Cheap (no agent calls).
 * Renders nothing while loading and nothing in non-local-only mode.
 */
export default function LocalOnlyBadge() {
  const [localOnly, setLocalOnly] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system/mode')
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (!cancelled) setLocalOnly(Boolean(data?.localOnly)); })
      .catch(() => { /* badge is non-essential — silently skip on error */ });
    return () => { cancelled = true; };
  }, []);

  if (!localOnly) return null;

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-medium rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800"
      title="No public domain set. Services run on local IP:port only — SSO, HTTPS, and reverse-proxy paths are off. Open Settings → Reverse Proxy to set a domain."
    >
      <Home size={11} />
      <span className="hidden sm:inline">Local-only</span>
    </span>
  );
}
