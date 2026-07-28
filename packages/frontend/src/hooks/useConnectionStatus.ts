'use client';

import { useEffect, useState } from 'react';
import { useSocket } from '@/hooks/useSocket';

/**
 * The realtime connection as the *user* should experience it (#2398).
 *
 * `useSocket().isConnected` is a raw mirror of the transport: it flips false
 * the instant a WebSocket dies, which on mobile happens routinely — the OS
 * freezes a backgrounded tab, the socket drops, and Socket.IO reconnects a
 * moment after the user returns. Rendering that raw boolean meant a red
 * "Connection lost" banner for every app-switch. This hook is the small state
 * machine between the transport and the UI:
 *
 * ```
 *                    connect
 *      ┌───────────────────────────────────┐
 *      │                                   │
 *  ┌───┴────┐   disconnect   ┌──────────────┐   grace expires    ┌─────────┐
 *  │ online │ ─────────────▶ │ reconnecting │ ─────────────────▶ │ offline │
 *  └────────┘                └──────────────┘   (VISIBLE only)   └─────────┘
 *                                   ▲                                 │
 *                                   └───────── connect ───────────────┘
 * ```
 *
 * - **online** — connected. No UI.
 * - **reconnecting** — down, but inside a grace window while Socket.IO's own
 *   auto-reconnect works on it. Deliberately produces **no alarming UI**: the
 *   overwhelming majority of drops resolve here.
 * - **offline** — the grace window expired *while the tab was visible*. Only
 *   now is it worth telling the user.
 *
 * Three rules make it behave on mobile:
 *
 * 1. **Visibility suspends escalation.** While the tab is hidden the
 *    reconnecting→offline timer does not run at all — a backgrounded tab
 *    losing its socket is expected, and nobody is looking. Becoming visible
 *    *restarts* a full grace window rather than inheriting however long the
 *    tab spent hidden, so returning after an hour is treated like a fresh
 *    drop, not an hour-long outage.
 * 2. **The grace window restarts on every disconnect cycle.** (The old
 *    `OfflineBanner` grace was a one-shot mount timer, which is exactly why
 *    the second and every later drop alarmed instantly.) Every input change —
 *    disconnect, reconnect, visibility flip — tears down the pending timer and
 *    starts a new one.
 * 3. **`offline` is sticky until an actual reconnect.** Once we've told the
 *    user the box is unreachable, hiding/showing the tab must not flap the
 *    banner off and back on; only a real `connect` clears it.
 */
export type ConnectionStatus = 'online' | 'reconnecting' | 'offline';

/** Grace for the *first* connect of a page-load. Short: nothing has ever
 *  worked yet, `useSocket` force-recycles a stalled handshake at 3s, and a
 *  user staring at a dead dashboard deserves to be told promptly. */
export const INITIAL_GRACE_MS = 2_500;

/** Grace for a drop from an established connection — the mobile-backgrounding
 *  case. Long enough to cover several Socket.IO reconnect attempts (its
 *  backoff caps at ~5s per try) plus the immediate re-dial `useSocket` fires
 *  on `visible`, so a normal return-to-tab never reaches `offline`. */
export const RECONNECT_GRACE_MS = 10_000;

const isTabVisible = () =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function useConnectionStatus() {
  const { isConnected, disconnectReason, disconnectCount, hasEverConnected } = useSocket();

  // Only TWO pieces of state live here, and neither is written from an effect
  // body: `visible` comes from a DOM event, `escalatedEpisode` from the grace
  // timer. `status` is *derived* during render, so the machine can never hold a
  // state its inputs contradict, and there are no cascading renders.
  const [visible, setVisible] = useState(isTabVisible);
  /** Which disconnection episode (`disconnectCount`) burned through its grace
   *  window. Recording escalation per *episode* rather than as a bare boolean
   *  is what makes `offline` both sticky (hiding/showing the tab mid-outage
   *  can't flap the banner) and self-resetting (the next drop is a new episode,
   *  so it starts un-escalated with a full window of its own). `-1` = none. */
  const [escalatedEpisode, setEscalatedEpisode] = useState(-1);

  /** We tore the socket down on purpose — never alarm about our own doing. */
  const deliberate = disconnectReason === 'io client disconnect';
  const escalated = escalatedEpisode === disconnectCount && !deliberate;

  const status: ConnectionStatus = isConnected
    ? 'online'
    : escalated
      ? 'offline'
      : 'reconnecting';

  useEffect(() => {
    const onVisibility = () => setVisible(isTabVisible());
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    // Rule 1: hidden tab → no escalation timer exists at all.
    if (isConnected || deliberate || !visible) return;

    // Rule 2: this effect re-runs on every input change and its cleanup clears
    // the pending timer, so the window restarts per cycle instead of firing
    // once for the lifetime of the component. A disconnect immediately followed
    // by a connect therefore never reaches the callback (debounce), and
    // hidden→visible starts a fresh window rather than inheriting the time
    // spent backgrounded.
    //
    // Every network-flavoured reason ("transport close", "ping timeout",
    // "transport error") gets the full window. So does "io server disconnect":
    // that means a restart, `useSocket` re-dials it, and ServerIdentityWatcher
    // greets the new session with its calm "ServiceBay updated" pill — flashing
    // red underneath that would be fighting it (#2203).
    const grace = hasEverConnected ? RECONNECT_GRACE_MS : INITIAL_GRACE_MS;
    const timer = setTimeout(() => setEscalatedEpisode(disconnectCount), grace);
    return () => clearTimeout(timer);
  }, [isConnected, deliberate, visible, disconnectCount, hasEverConnected]);

  return { status, isConnected, hasEverConnected, disconnectReason };
}
