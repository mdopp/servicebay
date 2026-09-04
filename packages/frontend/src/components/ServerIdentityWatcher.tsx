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
 *   - server restart                    → new sessionId, calm update pill
 *   - reinstall (setupCompleted: false) → forced immediate reload, since
 *                                          the wizard is binding anyway
 *
 * UX (#2203): the box is a heavily-exercised target and restarts often, so
 * a ticking countdown that force-reloads the page out from under the user
 * felt restless on mobile. Good practice for an "app updated, reload" prompt
 * is to be calm and never yank the page mid-interaction:
 *   - show a small, dismissible pill — no countdown, no surprise reload;
 *   - apply the pending reload QUIETLY the next time the tab is hidden
 *     (screen lock / app switch), so a mobile user returns to a fresh page;
 *   - the user can still Reload now (explicit) or Dismiss;
 *   - coalesce — once a reload is pending, further restarts don't re-trigger.
 *
 * Mounted once at the root layout.
 */

import { useEffect, useRef, useState } from 'react';
import { RefreshCcw, X } from 'lucide-react';
import { useSocket } from '@/hooks/useSocket';
import { Button } from '@/components/ui';

interface ServerIdentity {
  sessionId: string;
  setupCompleted: boolean;
}

export default function ServerIdentityWatcher() {
  const { socket } = useSocket();
  /** First identity received this page-load. Compared against every
   *  subsequent emit to detect a restart. */
  const initial = useRef<ServerIdentity | null>(null);
  /** True once a restart is detected — a reload is queued but NOT forced;
   *  the pill is shown and the reload applies quietly on next tab-hide. */
  const [pending, setPending] = useState(false);
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
        // skip the pill and reload immediately.
        window.location.reload();
        return;
      }

      if (restarted) {
        // Coalesce: setState to the same `true` is a no-op, so repeated
        // restarts never re-trigger or stack the pill.
        setPending(true);
      }
    }
    socket.on('server:identity', onIdentity);
    return () => {
      socket.off('server:identity', onIdentity);
    };
  }, [socket, dismissed]);

  // Quiet reload: once a reload is pending, apply it the next time the tab
  // is backgrounded (screen lock / app switch / tab change). The user is not
  // looking, so they return to a fresh page instead of being yanked.
  useEffect(() => {
    if (!pending) return;
    function onHidden() {
      if (document.visibilityState === 'hidden') {
        window.location.reload();
      }
    }
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, [pending]);

  if (!pending) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] max-w-md px-3.5 py-2 rounded-full border border-status-warn bg-surface shadow-lg flex items-center gap-2.5"
    >
      <RefreshCcw size={15} className="shrink-0 text-status-warn" />
      <span className="text-sm text-text">
        ServiceBay updated
      </span>
      <Button
        onClick={() => window.location.reload()}
        className="h-auto px-2.5 py-1 text-xs rounded-full bg-status-warn hover:bg-status-warn hover:opacity-80 text-white"
      >
        Reload
      </Button>
      <Button
        variant="ghost"
        aria-label="Dismiss"
        onClick={() => {
          setDismissed(true);
          setPending(false);
        }}
        className="h-auto p-0 text-status-warn hover:text-text hover:bg-transparent"
      >
        <X size={14} />
      </Button>
    </div>
  );
}
