/* eslint-disable @typescript-eslint/no-explicit-any */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the fake socket's event handlers so the test can fire them.
const handlers: Record<string, (arg?: any) => void> = {};
const fakeSocket = {
  connected: false,
  on: vi.fn((event: string, cb: (arg?: any) => void) => { handlers[event] = cb; }),
  off: vi.fn(),
};
vi.mock('socket.io-client', () => ({
  default: vi.fn(() => fakeSocket),
}));

import { useSocket } from '@/hooks/useSocket';

describe('useSocket — connect_error handling', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
  });

  it('redirects to /login on an unauthorized rejection, ignores transient errors', () => {
    const originalLocation = window.location;
    // jsdom's window.location is read-only; swap in a writable stub.
    Object.defineProperty(window, 'location', {
      value: { href: '' }, writable: true, configurable: true,
    });

    try {
      renderHook(() => useSocket());
      // The hook must subscribe to connect_error.
      expect(handlers.connect_error).toBeDefined();

      // A transient network connect_error must NOT redirect — Socket.IO
      // keeps retrying on its own.
      handlers.connect_error(new Error('xhr poll error'));
      expect(window.location.href).toBe('');

      // The server auth-middleware rejection ('unauthorized') — e.g. a
      // stale session cookie after a reinstall — bounces to /login.
      handlers.connect_error(new Error('unauthorized'));
      expect(window.location.href).toBe('/login');
    } finally {
      Object.defineProperty(window, 'location', {
        value: originalLocation, writable: true, configurable: true,
      });
    }
  });
});
