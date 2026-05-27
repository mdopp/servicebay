import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ErrorActions from '@/components/ErrorActions';

// Project style uses plain Chai matchers (toBeDefined / toBe), not the
// @testing-library/jest-dom matchers — see ConfirmModal.test.tsx + MobileNav.test.tsx.

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

describe('ErrorActions', () => {
  const reset = vi.fn();

  beforeEach(() => {
    reset.mockClear();
  });

  it('renders the three baseline buttons with the supplied retry label', () => {
    render(<ErrorActions reset={reset} retryLabel="Try again" />);

    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Run diagnostics' })).toBeDefined();

    // includeGoHome defaults to false — the global error boundary opts in,
    // the dashboard one does not.
    expect(screen.queryByRole('link', { name: 'Go home' })).toBeNull();
  });

  it('renders Go home only when includeGoHome is set', () => {
    render(<ErrorActions reset={reset} retryLabel="Retry" includeGoHome />);
    const home = screen.getByRole('link', { name: 'Go home' });
    expect(home).toBeDefined();
    expect(home.getAttribute('href')).toBe('/');
  });

  it('invokes reset() once per click', () => {
    render(<ErrorActions reset={reset} retryLabel="Try again" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('points "Run diagnostics" at /health', () => {
    render(<ErrorActions reset={reset} retryLabel="Try again" />);
    expect(screen.getByRole('link', { name: 'Run diagnostics' }).getAttribute('href')).toBe('/health');
  });

  it('exposes the consequence of each action via the title attribute (hover discoverability)', () => {
    render(<ErrorActions reset={reset} retryLabel="Try again" />);
    expect(screen.getByRole('button', { name: 'Try again' }).getAttribute('title')).toBe('Re-render this view');
    expect(screen.getByRole('button', { name: 'Reload page' }).getAttribute('title')).toBe('Reload the page from the server');
    expect(screen.getByRole('link', { name: 'Run diagnostics' }).getAttribute('title')).toBe('Run self-diagnostics to find the root cause');
  });

  it('reload-page button triggers window.location.reload', () => {
    const reloadSpy = vi.fn();
    const original = window.location;
    // jsdom's window.location.reload is the no-op stub; replace it with a spy.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload: reloadSpy },
    });
    try {
      render(<ErrorActions reset={reset} retryLabel="Try again" />);
      fireEvent.click(screen.getByRole('button', { name: 'Reload page' }));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
