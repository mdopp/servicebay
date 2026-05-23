// src/hooks/useSocket.ts
import { useEffect, useState } from 'react';
import io, { Socket } from 'socket.io-client';

let socket: Socket;

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
    // The path guard prevents an infinite reload loop on /login itself:
    // the root layout mounts DigitalTwinProvider unconditionally, so the
    // socket also connects from the login page; without the guard, every
    // failed connect would redirect the browser back to /login (#854).
    function onConnectError(err: Error) {
      if (
        err?.message === 'unauthorized' &&
        typeof window !== 'undefined' &&
        window.location.pathname !== '/login'
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
