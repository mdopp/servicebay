import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The hook under test sits on top of the raw transport mirror; drive that
// mirror directly so the tests exercise the state machine, not socket.io.
const socketState: {
  isConnected: boolean;
  disconnectReason: string | null;
  disconnectCount: number;
  hasEverConnected: boolean;
} = { isConnected: false, disconnectReason: null, disconnectCount: 0, hasEverConnected: false };

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ socket: null, ...socketState }),
}));

import {
  useConnectionStatus,
  INITIAL_GRACE_MS,
  RECONNECT_GRACE_MS,
} from '@/hooks/useConnectionStatus';

/** jsdom exposes `visibilityState` as a prototype getter — override it on the
 *  document instance, then fire the event the hook listens for. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

describe('useConnectionStatus — visibility-aware connection state machine (#2398)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    socketState.isConnected = false;
    socketState.disconnectReason = null;
    socketState.disconnectCount = 0;
    socketState.hasEverConnected = false;
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  /** Mount already-live, the way a real page is by the time a drop happens. */
  const startConnected = () => {
    socketState.isConnected = true;
    socketState.hasEverConnected = true;
  };

  const setup = () => {
    const view = renderHook(() => useConnectionStatus());
    /** Push a transport transition, maintaining the same episode bookkeeping
     *  `useSocket` does from the socket's own connect/disconnect callbacks. */
    const push = (next: { isConnected: boolean; disconnectReason?: string | null }) => {
      if (!next.isConnected && socketState.isConnected) socketState.disconnectCount += 1;
      if (next.isConnected) socketState.hasEverConnected = true;
      Object.assign(socketState, { disconnectReason: null }, next);
      act(() => { view.rerender(); });
    };
    const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
    return { ...view, push, advance };
  };

  it('reports online while the socket is connected', () => {
    startConnected();
    const { result, advance } = setup();
    expect(result.current.status).toBe('online');
    advance(60_000);
    expect(result.current.status).toBe('online');
  });

  it('starts in reconnecting — never a first-paint offline flash', () => {
    const { result } = setup();
    expect(result.current.status).toBe('reconnecting');
  });

  it('escalates a never-connected page to offline after the initial grace', () => {
    const { result, advance } = setup();
    advance(INITIAL_GRACE_MS - 100);
    expect(result.current.status).toBe('reconnecting');
    advance(200);
    expect(result.current.status).toBe('offline');
    // Never having connected must not read as a "connection lost" drop.
    expect(result.current.hasEverConnected).toBe(false);
  });

  it('gives an established connection the longer reconnect grace before alarming', () => {
    startConnected();
    const { result, push, advance } = setup();
    push({ isConnected: false, disconnectReason: 'transport close' });

    expect(result.current.status).toBe('reconnecting');
    advance(RECONNECT_GRACE_MS - 100);
    expect(result.current.status).toBe('reconnecting');
    advance(200);
    expect(result.current.status).toBe('offline');
    expect(result.current.hasEverConnected).toBe(true);
  });

  it('shows nothing when a disconnect is immediately followed by a reconnect (debounce)', () => {
    startConnected();
    const { result, push, advance } = setup();

    push({ isConnected: false, disconnectReason: 'transport close' });
    advance(500);
    push({ isConnected: true, disconnectReason: null });

    expect(result.current.status).toBe('online');
    // The stale escalation timer must have been torn down, not merely ignored.
    advance(60_000);
    expect(result.current.status).toBe('online');
  });

  it('restarts the grace window on EVERY disconnect cycle, not just the first', () => {
    // The core bug: OfflineBanner's old `graceOver` flipped once per mount, so
    // the 2nd and every later drop alarmed instantly.
    startConnected();
    const { result, push, advance } = setup();

    for (let cycle = 0; cycle < 3; cycle++) {
      push({ isConnected: false, disconnectReason: 'transport close' });
      advance(RECONNECT_GRACE_MS - 100);
      expect(result.current.status).toBe('reconnecting');
      push({ isConnected: true, disconnectReason: null });
      expect(result.current.status).toBe('online');
      advance(60_000);
      expect(result.current.status).toBe('online');
    }
  });

  it('never escalates while the tab is hidden, however long it stays hidden', () => {
    startConnected();
    const { result, push, advance } = setup();

    setVisibility('hidden');
    push({ isConnected: false, disconnectReason: 'transport close' });

    advance(10 * 60_000);
    expect(result.current.status).toBe('reconnecting');
  });

  it('grants a fresh grace window on hidden→visible instead of inheriting the hidden time', () => {
    startConnected();
    const { result, push, advance } = setup();

    setVisibility('hidden');
    push({ isConnected: false, disconnectReason: 'transport close' });
    advance(10 * 60_000); // ten minutes backgrounded

    setVisibility('visible');
    // A full window starts NOW — a ten-minute background is not ten minutes of
    // outage. This is the "return to the app" case from the issue.
    advance(RECONNECT_GRACE_MS - 100);
    expect(result.current.status).toBe('reconnecting');
    advance(200);
    expect(result.current.status).toBe('offline');
  });

  it('resolves a brief background-and-return with no alarm at all', () => {
    startConnected();
    const { result, push, advance } = setup();

    setVisibility('hidden');
    push({ isConnected: false, disconnectReason: 'transport close' }); // OS froze the socket
    advance(8_000);
    setVisibility('visible');
    advance(1_200); // socket.io (kicked on `visible`) gets back in
    push({ isConnected: true, disconnectReason: null });

    expect(result.current.status).toBe('online');
    advance(60_000);
    expect(result.current.status).toBe('online');
  });

  it('never alarms on a deliberate client-side disconnect', () => {
    startConnected();
    const { result, push, advance } = setup();

    push({ isConnected: false, disconnectReason: 'io client disconnect' });
    advance(10 * 60_000);
    expect(result.current.status).toBe('reconnecting');
  });

  it('gives a server-initiated close the full grace, so a restart stays calm', () => {
    // ServerIdentityWatcher greets the restarted server with its quiet
    // "ServiceBay updated" pill (#2203) — flashing red underneath it would be
    // fighting that UX. The alarm is still owed if it never comes back.
    startConnected();
    const { result, push, advance } = setup();

    push({ isConnected: false, disconnectReason: 'io server disconnect' });
    advance(RECONNECT_GRACE_MS - 100);
    expect(result.current.status).toBe('reconnecting');
    advance(200);
    expect(result.current.status).toBe('offline');
  });

  it('keeps offline sticky across a background/foreground flap until a real reconnect', () => {
    startConnected();
    const { result, push, advance } = setup();

    push({ isConnected: false, disconnectReason: 'ping timeout' });
    advance(RECONNECT_GRACE_MS + 100);
    expect(result.current.status).toBe('offline');

    // The box really is down; app-switching must not flap the banner off/on.
    setVisibility('hidden');
    expect(result.current.status).toBe('offline');
    setVisibility('visible');
    expect(result.current.status).toBe('offline');

    push({ isConnected: true, disconnectReason: null });
    expect(result.current.status).toBe('online');
  });
});
