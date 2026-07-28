// src/hooks/useSocket.ts
import { useEffect, useState } from 'react';
import io, { Socket } from 'socket.io-client';

let socket: Socket;

/** Recovery wiring is attached to the singleton socket ONCE, not per
 *  consumer — `useSocket` is called from ~6 components, and per-consumer
 *  listeners would fire the same reconnect kick six times. */
let recoveryWired = false;

/** Pathnames where an `unauthorized` socket error must NOT bounce the
 *  browser to /login. /login itself (the redirect target) and /portal
 *  (anonymous-readable family surface) — every other path is admin-
 *  flavored and the bounce is desirable. Kept in sync with the REST
 *  401 handler in DigitalTwinProvider. */
const ANONYMOUS_PATHS = new Set(['/login', '/portal']);

/** How long we wait for the *initial* connect to report `connected`
 *  before forcing a fresh reconnect attempt (#1509). The dashboard's
 *  hydration gate sits on "Connecting to ServiceBay" until `isConnected`
 *  flips; a single stalled first connect (stale socket from a prior
 *  navigation, a connect that never completed the handshake) left it
 *  hung for 30s+ with only a hard reload as recovery. A bounded kick
 *  turns that into a few-second self-recovery. */
const INITIAL_CONNECT_RETRY_MS = 3000;

/** How long to wait before re-dialling a socket the *server* closed. Socket.IO
 *  only auto-reconnects while `socket.active` is true; an `io server disconnect`
 *  leaves it false, so nothing retries and the page stays dead until a reload
 *  (#2398). We own that retry. */
const SERVER_CLOSE_RETRY_MS = 1000;

/**
 * Attach the singleton socket's self-recovery listeners. Idempotent — the
 * first `useSocket()` mount wires them for the lifetime of the page.
 *
 * Two recoveries, both aimed at the mobile "came back to the tab" case (#2398):
 *
 * 1. **visibilitychange → visible**: a backgrounded mobile tab gets its
 *    WebSocket frozen/killed by the OS, and the drop is frequently only
 *    *observed* the moment the user returns. Socket.IO would then wait out its
 *    own backoff (up to ~5s, plus the failed attempts before it). Dialling
 *    immediately on `visible` gets the reconnect done inside
 *    `useConnectionStatus`'s grace window, so no alarm ever surfaces.
 *    `ServerIdentityWatcher` owns the opposite transition (quiet reload on
 *    *hidden* when a server update is pending) — the two don't overlap.
 * 2. **a disconnect Socket.IO won't retry**: see `SERVER_CLOSE_RETRY_MS`. A
 *    deliberate client-side teardown (`io client disconnect`) is left alone —
 *    that one is intentional.
 */
function wireRecovery(s: Socket) {
  if (recoveryWired) return;
  recoveryWired = true;

  let serverCloseRetry: ReturnType<typeof setTimeout> | undefined;
  s.on('disconnect', (reason: Socket.DisconnectReason) => {
    if (s.active || reason === 'io client disconnect') return;
    clearTimeout(serverCloseRetry);
    serverCloseRetry = setTimeout(() => {
      if (!s.connected) s.connect();
    }, SERVER_CLOSE_RETRY_MS);
  });

  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !s.connected) s.connect();
  });
}

/**
 * The Socket.IO server's auth middleware (server.ts) rejects any connection
 * whose session cookie is missing or invalid with `Error('unauthorized')`. The
 * usual trigger is a stale cookie after a reinstall rotates AUTH_SECRET: the
 * dashboard then hangs forever on "Connecting to ServiceBay" because
 * `isConnected` never flips and nothing surfaces the auth failure (the loader
 * even mis-blames the agent's inventory pass). Mirror the REST-401 handler in
 * DigitalTwinProvider — bounce to /login so the operator re-authenticates.
 * Only the auth error redirects; transient network `connect_error`s must keep
 * retrying silently.
 *
 * The path guard prevents an infinite reload loop on /login itself (#854) AND
 * prevents the family portal from bouncing anonymous visitors to the admin
 * login: /portal is intentionally anonymous-readable, but the root layout still
 * mounts DigitalTwinProvider, which opens a socket connection that fails
 * `unauthorized` for visitors without an SB session cookie. Without the /portal
 * guard here, every anonymous /portal visit got redirected to /login a few
 * hundred ms after landing.
 */
function onConnectError(err: Error) {
  if (
    err?.message === 'unauthorized' &&
    typeof window !== 'undefined' &&
    !ANONYMOUS_PATHS.has(window.location.pathname) &&
    !window.location.pathname.startsWith('/portal/')
  ) {
    window.location.href = '/login';
  }
}

export const useSocket = () => {
  const [isConnected, setIsConnected] = useState(false);
  /** Why the socket last dropped, or `null` while connected. Drives the
   *  reason-aware escalation in `useConnectionStatus` (#2398). */
  const [disconnectReason, setDisconnectReason] = useState<Socket.DisconnectReason | null>(null);
  /** How many times the socket has dropped since this consumer mounted. It
   *  identifies the current *disconnection episode*, which is what lets
   *  `useConnectionStatus` grant a fresh grace window per drop instead of once
   *  per mount (#2398). Tracked here because the socket's own event callbacks
   *  are the only honest place to observe a transition. */
  const [disconnectCount, setDisconnectCount] = useState(0);
  /** Whether the socket has been live at least once — "still connecting" and
   *  "it dropped" are different stories to tell the user. */
  const [hasEverConnected, setHasEverConnected] = useState(false);

  useEffect(() => {
    if (!socket) {
        socket = io({ path: '/socket.io' });
    }
    wireRecovery(socket);

    function onConnect() {
      setIsConnected(true);
      setDisconnectReason(null);
      setHasEverConnected(true);
    }

    function onDisconnect(reason: Socket.DisconnectReason) {
      setIsConnected(false);
      setDisconnectReason(reason ?? null);
      setDisconnectCount((n) => n + 1);
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    if (socket.connected) {
        onConnect();
    } else {
        // The singleton socket persists across client-side navigations.
        // If a prior mount left it disconnected (a connect that never
        // completed, or an explicit disconnect), nothing re-initiates it
        // on a fresh mount — the gate then hangs on the socket phase
        // until a hard reload recreates the page. Kick the connect
        // explicitly; `socket.connect()` is a no-op when already
        // connecting/connected (#1509).
        socket.connect();
    }

    // Bounded retry on the *initial* connect: if the handshake hasn't
    // reported `connected` within the window, force one fresh reconnect
    // cycle. Socket.IO's own backoff handles repeated transport errors,
    // but a connect that silently stalls before `connect`/`connect_error`
    // fires isn't covered by that — this is the missing self-recovery the
    // hydration gate needs (#1509).
    const retryTimer = setTimeout(() => {
      if (!socket.connected) {
        socket.disconnect();
        socket.connect();
      }
    }, INITIAL_CONNECT_RETRY_MS);

    return () => {
      clearTimeout(retryTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
    };
  }, []);

  return { socket, isConnected, disconnectReason, disconnectCount, hasEverConnected };
};
