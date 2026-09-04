/**
 * Terminal — Button primitive swap (no-raw-ui-primitive sweep).
 *
 * The Clear and Reconnect toolbar buttons moved off raw `<button>` onto the
 * shared `<Button variant="ghost">` primitive from `@/components/ui`; the
 * component had no test at all, so that swap shipped with zero coverage.
 * xterm + socket.io-client are heavy runtime deps that don't matter here —
 * they're mocked to bare stubs so the test can render the real toolbar and
 * assert both buttons wire to their handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const termInstances: { clear: ReturnType<typeof vi.fn> }[] = [];
vi.mock('@xterm/xterm', () => {
  class FakeTerm {
    cols = 80;
    rows = 24;
    clear = vi.fn();
    write = vi.fn();
    dispose = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn();
    getSelection = vi.fn(() => '');
    attachCustomKeyEventHandler = vi.fn();
    constructor() {
      termInstances.push(this);
    }
  }
  return { Terminal: FakeTerm };
});

vi.mock('@xterm/addon-fit', () => {
  class FakeFitAddon {
    fit = vi.fn();
  }
  return { FitAddon: FakeFitAddon };
});

const mockSocket = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
// jsdom has no ResizeObserver; Terminal uses it directly off the global.
(global as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
  MockResizeObserver as unknown as typeof ResizeObserver;

import Terminal from './Terminal';

describe('Terminal — Button primitive swap (#no-raw-ui-primitive)', () => {
  beforeEach(() => {
    termInstances.length = 0;
    mockSocket.disconnect.mockClear();
    mockSocket.connect.mockClear();
  });

  it('renders Clear and Reconnect as real Buttons wired to their handlers', () => {
    render(<Terminal id="host" />);

    const clearButton = screen.getByTitle('Clear Terminal');
    expect(clearButton.tagName).toBe('BUTTON');
    fireEvent.click(clearButton);
    expect(termInstances[termInstances.length - 1].clear).toHaveBeenCalled();

    const reconnectButton = screen.getByTitle('Reconnect');
    expect(reconnectButton.tagName).toBe('BUTTON');
    fireEvent.click(reconnectButton);
    expect(mockSocket.disconnect).toHaveBeenCalled();
    expect(mockSocket.connect).toHaveBeenCalled();
  });

  it('hides the toolbar entirely when showControls is false', () => {
    render(<Terminal id="host" showControls={false} />);
    expect(screen.queryByTitle('Clear Terminal')).toBeNull();
    expect(screen.queryByTitle('Reconnect')).toBeNull();
  });
});
