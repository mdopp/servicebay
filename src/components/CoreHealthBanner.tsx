'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import Link from 'next/link';

/**
 * Core-stack health banner (#627 / Phase 3B).
 *
 * Shows at the top of every dashboard page when any service in the
 * `basic` stack (`nginx`, `auth`, `adguard`) reports `health.ready ===
 * false` for more than the startup grace. Names the specific service
 * that's degraded and links to its diagnose probe.
 *
 * Today the core-stack membership is hardcoded — it'll come from the
 * \`stacks/basic/stack.yml\` manifest (#625) once Phase 5 wires the
 * stack runner up to the wizard. Until then this list is the source
 * of truth for "what does the system need to function?"
 *
 * Polls every 15s, dismissable per browser session (sessionStorage).
 */

const CORE_SERVICES = ['nginx', 'auth', 'adguard'] as const;
const POLL_INTERVAL_MS = 15_000;
const DISMISS_KEY = 'sb:core-health-banner-dismissed';

interface ServiceHealth {
  ready: boolean;
  degraded?: boolean;
  lastCheckedAt: string;
  message?: string;
}

interface SystemInfoService {
  name: string;
  health?: ServiceHealth;
  active?: boolean;
}

interface SystemInfo {
  services?: SystemInfoService[];
}

export default function CoreHealthBanner() {
  const [unhealthy, setUnhealthy] = useState<string[]>([]);
  // Read once at construct time. sessionStorage is synchronous; only the
  // server side has to guard against it being undefined. Doing this in
  // useState's initialiser avoids the synchronous-setState-in-effect
  // anti-pattern the linter flags.
  const [dismissed, setDismissed] = useState<boolean>(() =>
    typeof window !== 'undefined' && sessionStorage.getItem(DISMISS_KEY) === '1',
  );

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/system/info');
        if (!res.ok) return;
        const data: SystemInfo = await res.json();
        if (cancelled) return;
        const services = Array.isArray(data.services) ? data.services : [];
        const flagged = CORE_SERVICES.filter(name => {
          const svc = services.find(s => s.name === name);
          if (!svc) return false;
          // A core service without a health record yet (template hasn't
          // shipped the annotation, or poller hasn't run) is NOT flagged.
          // We only surface explicit `ready: false` — the alternative is
          // a chatty banner while infrastructure templates without
          // healthcheck annotations roll out in Phase 3C.
          if (!svc.health) return false;
          return svc.health.ready === false;
        });
        setUnhealthy(flagged);
      } catch {
        /* keep previous state */
      }
    };
    void tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [dismissed]);

  if (dismissed || unhealthy.length === 0) return null;

  const dismiss = () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-40 max-w-2xl w-[calc(100%-2rem)] bg-red-50 dark:bg-red-950/40 border border-red-300 dark:border-red-800 rounded-xl shadow-lg overflow-hidden">
      <div className="p-3 flex items-start gap-3">
        <div className="shrink-0 p-1.5 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-300">
          <AlertTriangle size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-red-900 dark:text-red-100">
            Core service{unhealthy.length === 1 ? '' : 's'} unhealthy: {unhealthy.join(', ')}
          </h3>
          <p className="text-xs text-red-800/80 dark:text-red-200/80 mt-0.5">
            Feature installs are gated on core health. Open <Link href="/diagnose" className="underline font-medium">Self-diagnose</Link> for the recovery path.
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
