// src/hooks/useSocket.ts
import { useEffect, useState } from 'react';
import io, { Socket } from 'socket.io-client';

let socket: Socket;

/** Pathnames where an `unauthorized` socket error must NOT bounce the
 *  browser to /login. /login itself (the redirect target) and /portal
 *  (anonymous-readable family surface) — every other path is admin-
 *  flavored and the bounce is desirable. Kept in sync with the REST
 *  401 handler in DigitalTwinProvider. */
const ANONYMOUS_PATHS = new Set(['/login', '/portal']);

export const useSocket = () => {
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!socket) {
        socket = io({ path: '/socket.io' }); 
    }

    function onConnect() {
      setIsConnected(true);
    }

    function onDisconnect() {
      setIsConnected(false);
    }

    // The Socket.IO server's auth middleware (server.ts) rejects any
    // connection whose session cookie is missing or invalid with
    // `Error('unauthorized')`. The usual trigger is a stale cookie after
    // a reinstall rotates AUTH_SECRET: the dashboard then hangs forever
    // on "Connecting to ServiceBay" because `isConnected` never flips and
    // nothing surfaces the auth failure (the loader even mis-blames the
    // agent's inventory pass). Mirror the REST-401 handler in
    // DigitalTwinProvider — bounce to /login so the operator
    // re-authenticates. Only the auth error redirects; transient network
    // `connect_error`s must keep retrying silently.
    //
    // The path guard prevents an infinite reload loop on /login itself
    // (#854) AND prevents the family portal from bouncing anonymous
    // visitors to the admin login: /portal is intentionally
    // anonymous-readable, but the root layout still mounts
    // DigitalTwinProvider, which opens a socket connection that fails
    // `unauthorized` for visitors without an SB session cookie. Without
    // the /portal guard here, every anonymous /portal visit got
    // redirected to /login a few hundred ms after landing.
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

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    if (socket.connected) {
        onConnect();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
    };
  }, []);

  return { socket, isConnected };
};
