'use client';

import { useEffect, useRef } from 'react';
import { useSocket } from '@/hooks/useSocket';
import { useToast } from '@/providers/ToastProvider';

/**
 * Surfaces socket.io health to the user. Renders an inline dot meant to live
 * in PageHeader. Also fires a sticky warning toast on disconnect that clears
 * itself once the socket reconnects, so the dashboard can't silently freeze.
 */
export default function ConnectionIndicator({ inline = false }: { inline?: boolean }) {
  const { isConnected } = useSocket();
  const { addToast, removeToast } = useToast();
  const toastIdRef = useRef<string | null>(null);
  // Don't fire a "reconnected" toast on the first mount — only after a real drop.
  const hasBeenConnectedRef = useRef(false);

  useEffect(() => {
    if (isConnected) {
      if (toastIdRef.current) {
        removeToast(toastIdRef.current);
        toastIdRef.current = null;
        addToast('success', 'Reconnected', 'Live updates resumed.', 3000);
      }
      hasBeenConnectedRef.current = true;
      return;
    }

    if (!hasBeenConnectedRef.current) return; // initial connecting phase, not a drop
    if (toastIdRef.current) return; // already showing a sticky toast

    toastIdRef.current = addToast(
      'warning',
      'Connection lost',
      'Live updates paused. Trying to reconnect…',
      0,
    );
  }, [isConnected, addToast, removeToast]);

  const dot = (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        isConnected ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'
      }`}
      aria-hidden="true"
    />
  );

  if (inline) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[11px] font-medium text-gray-500 dark:text-gray-400"
        title={isConnected ? 'Live connection active' : 'Disconnected — retrying'}
        role="status"
        aria-live="polite"
      >
        {dot}
        <span className="hidden sm:inline">{isConnected ? 'Live' : 'Offline'}</span>
      </span>
    );
  }

  return dot;
}
