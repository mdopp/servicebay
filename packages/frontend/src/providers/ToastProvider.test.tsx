import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, renderHook, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { ToastProvider, useToast, type ToastType } from './ToastProvider';

afterEach(cleanup);

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);

/** A button-driven harness so callers exercise the real addToast API as the app does. */
function Harness() {
  const { addToast, removeToast } = useToast();
  return (
    <div>
      <button onClick={() => addToast('success', 'Saved', 'all good')}>add-success</button>
      <button onClick={() => addToast('error', 'Boom')}>add-error</button>
      <button onClick={() => addToast('warning', 'Careful')}>add-warning</button>
      <button onClick={() => addToast('info', 'FYI')}>add-info</button>
      <button onClick={() => addToast('loading', 'Working')}>add-loading</button>
      <button onClick={() => removeToast('nope')}>remove</button>
    </div>
  );
}

function renderWithProvider(node: React.ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

describe('ToastProvider', () => {
  it('useToast throws outside a provider', () => {
    function Bad() {
      useToast();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow(/useToast must be used within a ToastProvider/);
    spy.mockRestore();
  });

  it('renders the toast region top-right, above modals, responsive width', () => {
    renderWithProvider(<Harness />);
    const region = screen.getByRole('region', { name: 'Notifications' });
    expect(region.className).toContain('fixed');
    expect(region.className).toContain('top-4');
    expect(region.className).toContain('right-4');
    expect(region.className).not.toContain('bottom-4');
    // z-index above the app's highest modal (z-[120] FileViewerOverlay)
    expect(region.className).toMatch(/z-\[(2\d\d|[3-9]\d\d|\d{4,})\]/);
    // container is click-through, toasts are interactive
    expect(region.className).toContain('pointer-events-none');
    // responsive: full-ish width on small screens, capped on sm+
    expect(region.className).toContain('sm:max-w-sm');
  });

  it.each([
    ['add-success', 'ok', 'status-ok'],
    ['add-error', 'fail', 'status-fail'],
    ['add-warning', 'warn', 'status-warn'],
    ['add-info', 'info', 'status-info'],
    ['add-loading', 'info', 'status-info'],
  ] as const)('%s toast uses semantic status tokens (no raw color literals)', (btn, tone, token) => {
    renderWithProvider(<Harness />);
    act(() => { fireEvent.click(screen.getByText(btn)); });
    const toast = screen.getByRole('status');
    expect(toast.getAttribute('data-tone')).toBe(tone);
    expect(toast.className).toContain('pointer-events-auto');
    // built on the Card surface (bg-surface/border-border), not bg-white/gray-900
    expect(toast.className).toContain('bg-surface');
    expect(toast.className).toContain(`border-l-${token}`);
    expect(toast.className).not.toMatch(/bg-white|bg-gray-900/);
    expect(toast.className).not.toMatch(/border-green-\d|border-red-\d|border-yellow-\d|border-blue-\d/);
    // a StatusDot-style accent dot is present, tokenized
    expect(document.querySelector(`.bg-${token}.rounded-chip`)).not.toBeNull();
  });

  it('shows title and optional message', () => {
    renderWithProvider(<Harness />);
    act(() => { fireEvent.click(screen.getByText('add-success')); });
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('all good')).toBeTruthy();
  });

  it('stacks multiple toasts', () => {
    renderWithProvider(<Harness />);
    act(() => {
      fireEvent.click(screen.getByText('add-success'));
      fireEvent.click(screen.getByText('add-error'));
    });
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  it('dismiss button removes the toast', () => {
    renderWithProvider(<Harness />);
    act(() => { fireEvent.click(screen.getByText('add-success')); });
    expect(screen.getAllByRole('status')).toHaveLength(1);
    act(() => { fireEvent.click(screen.getByLabelText('Dismiss notification')); });
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  it('auto-dismisses after the duration', () => {
    vi.useFakeTimers();
    try {
      renderWithProvider(<Harness />);
      act(() => { fireEvent.click(screen.getByText('add-success')); });
      expect(screen.getAllByRole('status')).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(5000); });
      expect(screen.queryAllByRole('status')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('addToast returns an id and updateToast mutates that toast in place (API intact)', () => {
    const { result } = renderHook(() => useToast(), { wrapper });
    expect(typeof result.current.addToast).toBe('function');
    expect(typeof result.current.removeToast).toBe('function');
    expect(typeof result.current.updateToast).toBe('function');

    let id = '';
    act(() => { id = result.current.addToast('loading' as ToastType, 'Working', 'please wait', 0); });
    expect(typeof id).toBe('string');
    let toast = screen.getByRole('status');
    expect(toast.getAttribute('data-type')).toBe('loading');
    expect(screen.getByText('Working')).toBeTruthy();

    act(() => { result.current.updateToast(id, 'success', 'Done', 'finished', 0); });
    toast = screen.getByRole('status');
    expect(toast.getAttribute('data-type')).toBe('success');
    expect(screen.getByText('Done')).toBeTruthy();
    // updated in place, not appended
    expect(screen.getAllByRole('status')).toHaveLength(1);

    act(() => { result.current.removeToast(id); });
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });
});
