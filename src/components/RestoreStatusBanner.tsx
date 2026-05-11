'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';

interface ReinstallStatus {
  active: boolean;
  minutesRemaining?: number;
}

interface ServiceLike {
  name: string;
  active?: boolean;
  status?: string;
}

/**
 * Re-install welcome banner (#337). After setup-raid restores
 * Quadlet service definitions from the RAID backup, the dashboard
 * just sits there saying "Loading services…" while the user-systemd
 * instance churns through bringing them back up. Indistinguishable
 * from "nothing happened" — which is what you reported.
 *
 * This banner shows for up to 10 min after a re-install (set by
 * setup-config-merge.service via config.reinstall.completedAt), polls
 * /api/services to count how many managed services are active, and
 * auto-dismisses once they're all up. The operator can also dismiss
 * early.
 *
 * Doesn't render in fresh-install boots — config.reinstall is only
 * written when setup-config-merge took the merge path (existing
 * config.json was present on the RAID), so this stays invisible the
 * very first time.
 */
export default function RestoreStatusBanner() {
  const [status, setStatus] = useState<ReinstallStatus | null>(null);
  const [services, setServices] = useState<ServiceLike[] | null>(null);
  const [dismissing, setDismissing] = useState(false);

  const refresh = async () => {
    try {
      const [statusRes, servicesRes] = await Promise.all([
        fetch('/api/system/reinstall').then(r => (r.ok ? r.json() : null)),
        fetch('/api/services').then(r => (r.ok ? r.json() : [])),
      ]);
      setStatus(statusRes);
      setServices(Array.isArray(servicesRes) ? servicesRes : null);
    } catch {
      /* leave previous state — UI will fade out on the next clean poll */
    }
  };

  useEffect(() => {
    refresh();
    // Poll while the banner is plausibly active. 8s is fast enough
    // that the operator sees the count change as services come up,
    // slow enough that we're not hammering the API.
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, []);

  // Don't render anything when:
  //   - we haven't loaded status yet (avoid flash)
  //   - server says no active re-install
  //   - all managed services are already up (silently auto-dismiss
  //     while the underlying record decays)
  if (!status || !status.active) return null;

  const total = services?.length ?? 0;
  const up = services?.filter(s => s.active).length ?? 0;
  const allUp = total > 0 && up === total;

  if (allUp) {
    // Auto-dismiss the moment everything's running. Don't wait for
    // the operator to manually X out.
    return null;
  }

  const dismiss = async () => {
    setDismissing(true);
    try {
      await fetch('/api/system/reinstall', { method: 'DELETE' });
      setStatus({ active: false });
    } finally {
      setDismissing(false);
    }
  };

  return (
    <div className="fixed top-4 right-4 z-40 max-w-md bg-white dark:bg-gray-800 rounded-xl border border-blue-200 dark:border-blue-800 shadow-lg overflow-hidden">
      <div className="p-4 flex items-start gap-3">
        <div className="shrink-0 p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
          {total > 0 && up > 0 ? <RefreshCw size={20} className="animate-spin" /> : <Loader2 size={20} className="animate-spin" />}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Welcome back — restoring services from RAID backup
          </h3>
          <p className="text-xs text-gray-600 dark:text-gray-300 mt-1">
            {total > 0
              ? <>{up} of {total} services running. The rest are still starting up — Quadlet brings them back automatically after a re-install.</>
              : <>The agent is still picking up services from the RAID backup. This usually clears within a minute.</>}
          </p>
          {total > 0 && (
            <div className="mt-2 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 rounded-full transition-all duration-300"
                style={{ width: `${(up / total) * 100}%` }}
              />
            </div>
          )}
          {typeof status.minutesRemaining === 'number' && (
            <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 flex items-center gap-1">
              <CheckCircle2 size={10} />
              Auto-dismisses in {status.minutesRemaining} min.
            </p>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          disabled={dismissing}
          onClick={dismiss}
          className="shrink-0 p-1 rounded text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
