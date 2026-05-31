'use client';

import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import Link from 'next/link';
import { useCoreHealth } from '@/hooks/useCoreHealth';

/**
 * Core-stack health banner (#627 / Phase 3B, enriched in #635 /
 * Phase 5C).
 *
 * Shows at the top of every dashboard page when any `tier: core` stack
 * reports `health.ready !== true`. Sourced from the live stack
 * manifests via `/api/system/core-health` (shared with the Home
 * dashboard's health headline through {@link useCoreHealth}, so the two
 * can't disagree).
 *
 * Dismissable per browser session (sessionStorage).
 */

const DISMISS_KEY = 'sb:core-health-banner-dismissed';

export default function CoreHealthBanner() {
  const { degraded } = useCoreHealth();
  // Read once at construct time. sessionStorage is synchronous; only the
  // server side has to guard against it being undefined. Doing this in
  // useState's initialiser avoids the synchronous-setState-in-effect
  // anti-pattern the linter flags.
  const [dismissed, setDismissed] = useState<boolean>(() =>
    typeof window !== 'undefined' && sessionStorage.getItem(DISMISS_KEY) === '1',
  );

  if (dismissed || degraded.length === 0) return null;

  const dismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  // Only surface stacks that have a concrete "unhealthy" signal — pure
  // `unknown` (template has no healthcheck annotation yet) doesn't
  // warrant a red banner. Stays consistent with the tier-gate, which
  // treats `unknown` as "not ready" for install gating but doesn't
  // shout about it in the UI.
  const visible = degraded.filter(d => d.notReady.some(n => n.state === 'unhealthy'));
  if (visible.length === 0) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-40 max-w-2xl w-[calc(100%-2rem)] bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-800 rounded-xl shadow-lg overflow-hidden">
      <div className="p-3 flex items-start gap-3">
        <div className="shrink-0 p-1.5 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-300">
          <AlertTriangle size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-red-900 dark:text-red-100">
            Core {visible.length === 1 ? 'stack' : 'stacks'} unhealthy: {visible.map(d => d.label).join(', ')}
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {visible.flatMap(d => d.notReady.filter(n => n.state === 'unhealthy').map(n => (
              <li key={`${d.stack}/${n.template}`} className="text-xs text-red-800/90 dark:text-red-200/90">
                <code className="font-mono">{n.template}</code>{' '}
                <span className="text-red-700/70 dark:text-red-300/70">({n.state})</span>
                {/* #665 — S5: render the causal-chain hint when the
                    server inferred a known config-side blocker, so
                    operators see "X unhealthy → because Y, click Z"
                    instead of a bare "(unhealthy)" red badge. */}
                {n.cause && (
                  <div className="mt-0.5 ml-3 text-red-800/80 dark:text-red-200/80">
                    → {n.cause.summary}
                    {n.cause.action && (
                      <>
                        {' '}
                        <Link href={n.cause.action.href} className="underline font-medium">
                          {n.cause.action.label}
                        </Link>
                      </>
                    )}
                  </div>
                )}
              </li>
            )))}
          </ul>
          <p className="text-xs text-red-800/80 dark:text-red-200/80 mt-2">
            Feature installs are gated on core health. Open <Link href="/diagnose" className="underline font-medium">Self-diagnose</Link> for the full recovery path.
          </p>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          className="shrink-0 p-1 rounded text-red-400 hover:text-red-700 dark:hover:text-red-200 hover:bg-red-100/60 dark:hover:bg-red-900/40"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
