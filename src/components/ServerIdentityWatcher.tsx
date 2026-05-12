'use client';

/**
 * Detects ServiceBay server restarts + `setupCompleted` flips that happen
 * while the page is open, and prompts the user to reload before the stale
 * UI gets them stuck.
 *
 * Server emits `server:identity` on every socket (re)connect with
 * `{ sessionId, setupCompleted }`. `sessionId` is regenerated per process
 * start, so:
 *   - normal reconnect (network blip)   → same sessionId, no action
 *   - server restart                    → new sessionId, banner + 10s
 *                                          auto-reload
 *   - reinstall (setupCompleted: false) → forced immediate reload, since
 *                                          the wizard is binding anyway
 *
 * Mounted once at the root layout. Renders a small fixed banner at the
 * top of the viewport when a restart is detected; auto-reloads after
 * `RELOAD_GRACE_SECONDS`. The user can click "Reload now" to skip the
 * countdown or "Dismiss" to hide the banner for the current session
 * (useful if they're mid-form and want to copy something out first —
 * they still control when to refresh).
 */

import { useEffect, useRef, useState } from 'react';
import { RefreshCcw, X } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';

interface ServerIdentity {
  sessionId: string;
  setupCompleted: boolean;
}

const RELOAD_GRACE_SECONDS = 10;

export default function ServerIdentityWatcher() {
  const { socket } = useSocket();
  /** First identity received this page-load. Compared against every
   *  subsequent emit to detect a restart. */
  const initial = useRef<ServerIdentity | null>(null);
  /** When non-null, the banner is shown with `remaining` seconds left. */
  const [reload, setReload] = useState<{ remaining: number } | null>(null);
  /** True once the user clicks Dismiss; suppresses further detection
   *  until the page is reloaded. */
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // `useSocket` initializes the singleton socket inside its own
    // useEffect, which runs after the first render returns. The very
    // first time this component renders the destructured `socket`
    // value is still `undefined`; reading `.on()` on it crashed the
    // app at the root layout (TypeError: Cannot read properties of
    // undefined (reading 'on')). Bail out until the next render fires
    // with the initialized socket — `socket` is in the dep array so
    // the effect re-runs once `useSocket` returns a defined value.
    if (!socket) return;
    function onIdentity(data: ServerIdentity) {
      if (initial.current === null) {
        initial.current = data;
        return;
      }
      if (dismissed) return;

      const setupReverted = initial.current.setupCompleted && !data.setupCompleted;
      const restarted = initial.current.sessionId !== data.sessionId;

      if (setupReverted) {
        // The install wizard is showing again — every API call from this
        // page will redirect / 401. There's no useful state to preserve;
        // skip the banner and reload immediately.
        window.location.reload();
        return;
      }

      if (restarted) {
        setReload({ remaining: RELOAD_GRACE_SECONDS });
      }
    }
    socket.on('server:identity', onIdentity);
    return () => {
      socket.off('server:identity', onIdentity);
    };
  }, [socket, dismissed]);

  // Countdown + auto-reload at zero.
  useEffect(() => {
    if (!reload) return;
    if (reload.remaining <= 0) {
      window.location.reload();
      return;
    }
    const t = setTimeout(() => {
      setReload(r => (r ? { ...r, remaining: r.remaining - 1 } : null));
    }, 1000);
    return () => clearTimeout(t);
  }, [reload]);

  if (!reload) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] max-w-md px-4 py-2.5 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 shadow-lg flex items-center gap-3"
    >
      <RefreshCcw size={16} className="shrink-0 text-amber-700 dark:text-amber-300" />
      <span className="text-sm text-amber-900 dark:text-amber-100">
        ServiceBay was restarted. Reloading in {reload.remaining}s…
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="text-xs font-medium px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white"
      >
        Reload now
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true);
          setReload(null);
        }}
        className="text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100"
      >
        <X size={14} />
      </button>
    </div>
  );
}
