'use client';

import { useEffect, useRef, useState } from 'react';
import { useSocket } from '@/hooks/useSocket';
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
 */
export default function OfflineBanner() {
  const { isConnected } = useSocket();
  const { state: installState } = useInstallMonitor();
  const installActive = installState !== null;
  const { addToast, removeToast } = useToast();
  const toastIdRef = useRef<string | null>(null);
  // A short grace so the first-mount "connecting" phase doesn't flash the
  // banner; after it elapses, any disconnect shows immediately. (Set from a
  // timer callback, not synchronously in the effect body.)
  const hasConnectedRef = useRef(false);
  const [graceOver, setGraceOver] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setGraceOver(true), 2500);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    // A live install poll proves the box is reachable — clear any sticky
    // "Connection lost" toast and stay quiet even while the socket is
    // momentarily down (#1504).
    if (isConnected || installActive) {
      if (toastIdRef.current) {
        removeToast(toastIdRef.current);
        toastIdRef.current = null;
        if (isConnected) addToast('success', 'Reconnected', 'Live updates resumed.', 3000);
      }
      if (isConnected) hasConnectedRef.current = true;
      return;
    }
    if (!hasConnectedRef.current) return; // initial connecting phase, not a drop
    if (toastIdRef.current) return; // already showing the sticky toast
    toastIdRef.current = addToast(
      'warning',
      'Connection lost',
      'Live updates paused. Trying to reconnect…',
      0,
    );
  }, [isConnected, installActive, addToast, removeToast]);

  const offline = !isConnected && graceOver && !installActive;
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
