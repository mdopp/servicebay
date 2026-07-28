import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import OfflineBanner from './OfflineBanner';
import { ToastProvider } from '../providers/ToastProvider';

// Both signals the banner reconciles (#1504): the realtime socket state
// and whether an install poll is currently succeeding.
let connected = true;
let disconnectReason: string | null = null;
let disconnectCount = 0;
let hasEverConnected = false;
let installActive = false;

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({
    socket: null,
    isConnected: connected,
    disconnectReason,
    disconnectCount,
    hasEverConnected,
  }),
}));

/** Drive a transport transition, keeping the episode bookkeeping `useSocket`
 *  does from the socket's own connect/disconnect callbacks. */
function transport(next: { connected: boolean; reason?: string | null }) {
  if (!next.connected && connected) disconnectCount += 1;
  if (next.connected) hasEverConnected = true;
  connected = next.connected;
  disconnectReason = next.reason ?? null;
}
vi.mock('@/hooks/useInstallMonitor', () => ({
  useInstallMonitor: () => ({
    state: installActive ? { jobId: 'j1', phase: 'running' } : null,
    skipCredentials: vi.fn(),
  }),
}));

const renderBanner = () => render(<ToastProvider><OfflineBanner /></ToastProvider>);

/** jsdom exposes `visibilityState` as a prototype getter — override it on the
 *  document instance, then fire the event `useConnectionStatus` listens for. */
function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
}

const bannerShown = () => screen.queryByText(/Not online/i) !== null;

describe('OfflineBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connected = true;
    disconnectReason = null;
    disconnectCount = 0;
    hasEverConnected = false;
    installActive = false;
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('stays hidden while connected', () => {
    connected = true;
    renderBanner();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText(/Not online/i)).toBeNull();
  });

  it('shows after the grace once disconnected', () => {
    connected = false;
    renderBanner();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText(/Not online/i)).not.toBeNull();
  });

  it('suppresses the banner while an install is actively advancing (#1504)', () => {
    // Socket reports down, but the install poll is succeeding — the box
    // is reachable, so the "Not online" alarm must not fire.
    connected = false;
    installActive = true;
    renderBanner();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText(/Not online/i)).toBeNull();
  });

  it('stays silent through a brief background-and-return on mobile (#2398)', () => {
    hasEverConnected = true; // the page has been live for a while
    const { rerender } = renderBanner();
    const push = () => act(() => {
      rerender(<ToastProvider><OfflineBanner /></ToastProvider>);
    });

    // The OS backgrounds the tab and freezes the WebSocket.
    setVisibility('hidden');
    transport({ connected: false, reason: 'transport close' });
    push();
    act(() => { vi.advanceTimersByTime(9000); });
    expect(bannerShown()).toBe(false);

    // Back to the app; socket.io reconnects a beat later.
    setVisibility('visible');
    act(() => { vi.advanceTimersByTime(1200); });
    expect(bannerShown()).toBe(false);
    transport({ connected: true });
    push();
    act(() => { vi.advanceTimersByTime(60000); });
    expect(bannerShown()).toBe(false);
    // …and no "Connection lost" narrative was ever told.
    expect(screen.queryByText(/Connection lost/i)).toBeNull();
  });

  it('re-grants the grace on a SECOND drop, not just the first (#2398)', () => {
    // The old one-shot `graceOver` flipped once per mount, so every drop after
    // the first alarmed instantly.
    hasEverConnected = true;
    const { rerender } = renderBanner();
    const push = () => act(() => {
      rerender(<ToastProvider><OfflineBanner /></ToastProvider>);
    });

    for (const _cycle of [1, 2]) {
      transport({ connected: false, reason: 'transport close' });
      push();
      act(() => { vi.advanceTimersByTime(3000); });
      expect(bannerShown()).toBe(false); // still inside the reconnect grace
      transport({ connected: true });
      push();
      expect(bannerShown()).toBe(false);
    }
  });

  it('still surfaces the banner when the box is genuinely down while visible (#2398)', () => {
    hasEverConnected = true;
    const { rerender } = renderBanner();
    transport({ connected: false, reason: 'ping timeout' });
    act(() => { rerender(<ToastProvider><OfflineBanner /></ToastProvider>); });

    act(() => { vi.advanceTimersByTime(11000); });
    expect(bannerShown()).toBe(true);
    // A drop from a live connection also tells the "lost it" story.
    expect(screen.queryByText(/Connection lost/i)).not.toBeNull();
  });
});
