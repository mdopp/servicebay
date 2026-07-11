import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

// A controllable mock socket: tests drive `server:identity` emits directly.
const handlers: Record<string, ((data: unknown) => void)[]> = {};
const mockSocket = {
  on: (ev: string, fn: (data: unknown) => void) => {
    (handlers[ev] ||= []).push(fn);
  },
  off: (ev: string, fn: (data: unknown) => void) => {
    handlers[ev] = (handlers[ev] || []).filter((h) => h !== fn);
  },
};
function emitIdentity(data: { sessionId: string; setupCompleted: boolean }) {
  act(() => {
    (handlers['server:identity'] || []).forEach((h) => h(data));
  });
}

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => ({ socket: mockSocket, isConnected: true }),
}));

import ServerIdentityWatcher from './ServerIdentityWatcher';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('ServerIdentityWatcher — calm update prompt (#2203)', () => {
  const reload = vi.fn();

  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    reload.mockClear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    });
    setVisibility('visible');
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows no banner on the first identity or on a same-session reconnect', () => {
    render(<ServerIdentityWatcher />);
    emitIdentity({ sessionId: 'A', setupCompleted: true });
    emitIdentity({ sessionId: 'A', setupCompleted: true }); // reconnect, same process
    expect(screen.queryByText(/ServiceBay updated/i)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('on restart shows a calm pill and does NOT auto-reload while visible (no countdown)', () => {
    render(<ServerIdentityWatcher />);
    emitIdentity({ sessionId: 'A', setupCompleted: true });
    emitIdentity({ sessionId: 'B', setupCompleted: true }); // restart

    expect(screen.getByText(/ServiceBay updated/i)).toBeTruthy();
    // No ticking countdown text, and crucially no forced reload while the
    // user is actively viewing the page.
    expect(screen.queryByText(/Reloading in/i)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('applies the pending reload quietly when the tab is hidden', () => {
    render(<ServerIdentityWatcher />);
    emitIdentity({ sessionId: 'A', setupCompleted: true });
    emitIdentity({ sessionId: 'B', setupCompleted: true });

    expect(reload).not.toHaveBeenCalled();
    setVisibility('hidden'); // screen lock / app switch
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('coalesces — repeated restarts never stack or re-trigger the pill', () => {
    render(<ServerIdentityWatcher />);
    emitIdentity({ sessionId: 'A', setupCompleted: true });
    emitIdentity({ sessionId: 'B', setupCompleted: true });
    emitIdentity({ sessionId: 'C', setupCompleted: true });
    expect(screen.getAllByText(/ServiceBay updated/i)).toHaveLength(1);
  });

  it('Dismiss hides the pill and suppresses further detection', () => {
    render(<ServerIdentityWatcher />);
    emitIdentity({ sessionId: 'A', setupCompleted: true });
    emitIdentity({ sessionId: 'B', setupCompleted: true });

    act(() => screen.getByLabelText('Dismiss').click());
    expect(screen.queryByText(/ServiceBay updated/i)).toBeNull();

    emitIdentity({ sessionId: 'D', setupCompleted: true }); // another restart
    expect(screen.queryByText(/ServiceBay updated/i)).toBeNull();
    // Dismissed → a later tab-hide must not reload.
    setVisibility('hidden');
    expect(reload).not.toHaveBeenCalled();
  });

  it('setupCompleted → false forces an immediate reload (reinstall wizard)', () => {
    render(<ServerIdentityWatcher />);
    emitIdentity({ sessionId: 'A', setupCompleted: true });
    emitIdentity({ sessionId: 'A', setupCompleted: false });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
