'use client';

import { useEffect, useRef, useState } from 'react';
import { useSocket } from '@/hooks/useSocket';
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
 */
export default function OfflineBanner() {
  const { isConnected } = useSocket();
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
    if (isConnected) {
      if (toastIdRef.current) {
        removeToast(toastIdRef.current);
        toastIdRef.current = null;
        addToast('success', 'Reconnected', 'Live updates resumed.', 3000);
      }
      hasConnectedRef.current = true;
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
  }, [isConnected, addToast, removeToast]);

  const offline = !isConnected && graceOver;
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
