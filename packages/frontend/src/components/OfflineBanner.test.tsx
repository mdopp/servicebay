import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import OfflineBanner from './OfflineBanner';
import { ToastProvider } from '../providers/ToastProvider';

// Both signals the banner reconciles (#1504): the realtime socket state
// and whether an install poll is currently succeeding.
let connected = true;
let installActive = false;

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ socket: null, isConnected: connected }),
}));
vi.mock('@/hooks/useInstallMonitor', () => ({
  useInstallMonitor: () => ({
    state: installActive ? { jobId: 'j1', phase: 'running' } : null,
    skipCredentials: vi.fn(),
  }),
}));

const renderBanner = () => render(<ToastProvider><OfflineBanner /></ToastProvider>);

describe('OfflineBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connected = true;
    installActive = false;
  });
  afterEach(() => {
    vi.useRealTimers();
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
});
