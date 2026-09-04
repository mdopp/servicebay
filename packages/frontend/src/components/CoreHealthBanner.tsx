'use client';

import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import Link from 'next/link';
import { useCoreHealth } from '@/hooks/useCoreHealth';
import { Button } from '@/components/ui';

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
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-40 max-w-2xl w-[calc(100%-2rem)] bg-status-fail/10 border border-status-fail/40 rounded-xl shadow-lg overflow-hidden">
      <div className="p-3 flex items-start gap-3">
        <div className="shrink-0 p-1.5 rounded-lg bg-status-fail/15 text-status-fail">
          <AlertTriangle size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-text">
            Core {visible.length === 1 ? 'stack' : 'stacks'} unhealthy: {visible.map(d => d.label).join(', ')}
          </h3>
          <ul className="mt-1.5 space-y-1.5">
            {visible.flatMap(d => d.notReady.filter(n => n.state === 'unhealthy').map(n => (
              <li key={`${d.stack}/${n.template}`} className="text-xs text-status-fail/90">
                <code className="font-mono">{n.template}</code>{' '}
                <span className="text-status-fail/70">({n.state})</span>
                {/* #665 — S5: render the causal-chain hint when the
                    server inferred a known config-side blocker, so
                    operators see "X unhealthy → because Y, click Z"
                    instead of a bare "(unhealthy)" red badge. */}
                {n.cause && (
                  <div className="mt-0.5 ml-3 text-status-fail/80">
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
          <p className="text-xs text-status-fail/80 mt-2">
            Feature installs are gated on core health. Open <Link href="/diagnose" className="underline font-medium">Self-diagnose</Link> for the full recovery path.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          aria-label="Dismiss"
          onClick={dismiss}
          className="h-auto w-auto shrink-0 p-1 text-status-fail hover:bg-status-fail/10 hover:text-status-fail/80"
        >
          <X size={14} />
        </Button>
      </div>
    </div>
  );
}
