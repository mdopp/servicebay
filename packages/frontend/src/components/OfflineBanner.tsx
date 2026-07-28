'use client';

import { useEffect, useRef } from 'react';
import { useConnectionStatus } from '@/hooks/useConnectionStatus';
import { useInstallMonitor } from '@/hooks/useInstallMonitor';
import { useToast } from '@/providers/ToastProvider';

/**
 * Global offline cue for the dashboard. When the realtime socket is down, a
 * red bar pins to the top ("Not online — trying to reconnect…") and a thin red
 * ring frames the viewport, so a frozen dashboard is impossible to miss.
 *
 * Renders nothing while connected — there's no always-on "Live" chrome to spend
 * space on (that was the old PageHeader ConnectionIndicator, now removed). This
 * component also owns the sticky connection-lost / reconnected toasts that the
 * indicator used to fire.
 *
 * During the box's own install the realtime socket can drop transiently (the
 * server restarts / the box reboots mid-install) while the install-progress
 * poll keeps succeeding — proving the box IS reachable. Flashing "Not online"
 * over a clearly-advancing install is a false alarm (#1504), so the banner and
 * its sticky toast are suppressed whenever an install job is active: a
 * succeeding `/api/install/progress` poll is a positive liveness signal that
 * outranks a momentarily-down socket.
 *
 * The "is it actually down?" judgement is NOT made here — it belongs to
 * `useConnectionStatus`, which turns the raw transport boolean into
 * online/reconnecting/offline with a per-cycle, visibility-aware grace window
 * (#2398). This component renders the `offline` state and nothing else; a
 * routine mobile app-switch never reaches it.
 */
export default function OfflineBanner() {
  const { status, hasEverConnected } = useConnectionStatus();
  const { state: installState } = useInstallMonitor();
  const installActive = installState !== null;
  const { addToast, removeToast } = useToast();
  const toastIdRef = useRef<string | null>(null);

  const offline = status === 'offline' && !installActive;

  useEffect(() => {
    // The sticky toast is the *drop* narrative ("lost … reconnected"), so it
    // only applies once the connection has actually been live at least once —
    // a page that never connected gets the banner, not a "lost it" story.
    if (offline && hasEverConnected) {
      if (!toastIdRef.current) {
        toastIdRef.current = addToast(
          'warning',
          'Connection lost',
          'Live updates paused. Trying to reconnect…',
          0,
        );
      }
      return;
    }
    // Back online, or the install poll proves the box is reachable after all
    // (#1504) — drop the sticky toast, and celebrate only a real reconnect.
    if (toastIdRef.current) {
      removeToast(toastIdRef.current);
      toastIdRef.current = null;
      if (status === 'online') addToast('success', 'Reconnected', 'Live updates resumed.', 3000);
    }
  }, [offline, status, hasEverConnected, addToast, removeToast]);

  if (!offline) return null;

  return (
    <>
      <div
        role="status"
        aria-live="assertive"
        className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2 px-4 py-1.5 text-sm font-semibold text-white bg-red-600 shadow-md"
      >
        <span className="inline-block w-2 h-2 rounded-full bg-white animate-pulse" aria-hidden="true" />
        Not online — trying to reconnect…
      </div>
      {/* Thin red frame so the whole UI reads as degraded, without a full wash. */}
      <div className="pointer-events-none fixed inset-0 z-40 ring-2 ring-inset ring-red-500/60" aria-hidden="true" />
    </>
  );
}
