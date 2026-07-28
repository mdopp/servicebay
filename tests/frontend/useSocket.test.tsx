/* eslint-disable @typescript-eslint/no-explicit-any */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the fake socket's event handlers so the test can fire them. Several
// listeners share an event (the hook's own, plus the singleton's recovery
// wiring), so keep a list per event and mirror `off` faithfully — RTL's
// auto-cleanup unmounts between tests, which unregisters the per-hook ones and
// leaves the singleton's in place, exactly as in the browser.
const handlers: Record<string, ((arg?: any) => void)[]> = {};
const fakeSocket = {
  connected: false,
  /** socket.io's "will auto-reconnect on its own" flag. */
  active: true,
  on: vi.fn((event: string, cb: (arg?: any) => void) => {
    (handlers[event] ||= []).push(cb);
  }),
  off: vi.fn((event: string, cb: (arg?: any) => void) => {
    handlers[event] = (handlers[event] || []).filter((h) => h !== cb);
  }),
  connect: vi.fn(),
  disconnect: vi.fn(),
};
const fire = (event: string, arg?: any) => {
  for (const h of [...(handlers[event] || [])]) h(arg);
};
vi.mock('socket.io-client', () => ({
  default: vi.fn(() => fakeSocket),
}));

import { useSocket } from '@/hooks/useSocket';

describe('useSocket — connect_error handling', () => {
  beforeEach(() => {
    fakeSocket.connected = false;
    fakeSocket.active = true;
    fakeSocket.connect.mockClear();
    fakeSocket.disconnect.mockClear();
  });

  it('redirects to /login on an unauthorized rejection, ignores transient errors', () => {
    const originalLocation = window.location;
    // jsdom's window.location is read-only; swap in a writable stub.
    Object.defineProperty(window, 'location', {
      value: { href: '', pathname: '/services' }, writable: true, configurable: true,
    });

    try {
      renderHook(() => useSocket());
      // The hook must subscribe to connect_error.
      expect(handlers.connect_error?.length).toBeGreaterThan(0);

      // A transient network connect_error must NOT redirect — Socket.IO
      // keeps retrying on its own.
      fire('connect_error', new Error('xhr poll error'));
      expect(window.location.href).toBe('');

      // The server auth-middleware rejection ('unauthorized') — e.g. a
      // stale session cookie after a reinstall — bounces to /login.
      fire('connect_error', new Error('unauthorized'));
      expect(window.location.href).toBe('/login');
    } finally {
      Object.defineProperty(window, 'location', {
        value: originalLocation, writable: true, configurable: true,
      });
    }
  });

  it('does NOT redirect when already on /login (#854 — prevents reload loop)', () => {
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { href: 'http://x/login', pathname: '/login' }, writable: true, configurable: true,
    });

    try {
      renderHook(() => useSocket());
      fire('connect_error', new Error('unauthorized'));
      // Must NOT have been replaced — staying on /login lets the user log in.
      expect(window.location.href).toBe('http://x/login');
    } finally {
      Object.defineProperty(window, 'location', {
        value: originalLocation, writable: true, configurable: true,
      });
    }
  });

  it('kicks the connect on mount when the persisted socket is disconnected (#1509)', () => {
    fakeSocket.connected = false;
    renderHook(() => useSocket());
    // The singleton can persist across navigations disconnected; the hook
    // must re-initiate the connect rather than hang the hydration gate.
    expect(fakeSocket.connect).toHaveBeenCalled();
  });

  it('forces a fresh reconnect if the initial connect stalls (#1509)', () => {
    vi.useFakeTimers();
    try {
      fakeSocket.connected = false;
      renderHook(() => useSocket());
      fakeSocket.connect.mockClear();
      // Still not connected after the bounded window → recycle the socket.
      vi.advanceTimersByTime(3000);
      expect(fakeSocket.disconnect).toHaveBeenCalled();
      expect(fakeSocket.connect).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exposes the disconnect reason so the UI can judge how alarming it is (#2398)', () => {
    const { result } = renderHook(() => useSocket());
    expect(result.current.disconnectReason).toBeNull();

    act(() => { fire('disconnect', 'transport close'); });
    expect(result.current.isConnected).toBe(false);
    expect(result.current.disconnectReason).toBe('transport close');

    act(() => { fire('connect'); });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.disconnectReason).toBeNull();
  });

  it('re-dials the moment the tab becomes visible again (#2398)', () => {
    renderHook(() => useSocket());
    fakeSocket.connected = false;
    fakeSocket.connect.mockClear();

    // A mobile OS freezes a backgrounded tab's socket; waiting out socket.io's
    // backoff is what let the banner beat the reconnect to the screen.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fakeSocket.connect).toHaveBeenCalled();

    // …and no pointless re-dial when the socket is already up.
    fakeSocket.connected = true;
    fakeSocket.connect.mockClear();
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(fakeSocket.connect).not.toHaveBeenCalled();
  });

  it('owns the retry when socket.io will not reconnect on its own (#2398)', () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useSocket());
      fakeSocket.connected = false;
      fakeSocket.connect.mockClear();

      // `active: false` = the server closed us out; socket.io stops retrying
      // and the page would stay dead until a reload.
      fakeSocket.active = false;
      act(() => { fire('disconnect', 'io server disconnect'); });
      expect(fakeSocket.connect).not.toHaveBeenCalled(); // not instantly — brief settle
      act(() => { vi.advanceTimersByTime(1000); });
      expect(fakeSocket.connect).toHaveBeenCalled();

      // A teardown we asked for is left alone. (Stay under the 3s
      // stalled-initial-connect kick, which is a different recovery.)
      fakeSocket.connect.mockClear();
      act(() => { fire('disconnect', 'io client disconnect'); });
      act(() => { vi.advanceTimersByTime(1500); });
      expect(fakeSocket.connect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
