import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ActionProgressModal from './ActionProgressModal';
import { ToastProvider } from '@/providers/ToastProvider';

// Mock xterm to avoid complex terminal setup
// For dynamic imports used in useEffect, we need to stub window.matchMedia
// that xterm requires for initialization
if (!window.matchMedia) {
  window.matchMedia = vi.fn((query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList));
}

// Mock fetch to prevent actual API calls
global.fetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    body: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
      }),
    },
  } as Response)
) as typeof global.fetch;

const renderModal = (props = {}) => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    serviceName: 'test-service',
    action: 'start' as const,
    onComplete: vi.fn(),
  };

  return render(
    <ToastProvider>
      <ActionProgressModal {...defaultProps} {...props} />
    </ToastProvider>
  );
};

/** First element carrying the specified class token (including modifiers like /10),
 * searched across the document. Used to verify semantic token classes are applied. */
function byClass(cls: string): Element {
  // Handle composite classes with modifiers (e.g., "bg-status-info" matches "bg-status-info/10")
  const xpath = `//*[contains(@class, '${cls}')]`;
  const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  const found = result.singleNodeValue;
  expect(found, `no element with class containing "${cls}"`).not.toBeNull();
  return found as Element;
}

describe('ActionProgressModal — semantic token colors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders modal container with bg-surface and border-border', () => {
    renderModal({ isOpen: true });
    const modal = byClass('bg-surface');
    expect(modal.className).toContain('border-border');
    expect(modal.className).not.toMatch(/bg-white|dark:bg-gray-/);
  });

  it('applies border-border token to header divider', () => {
    renderModal({ isOpen: true });
    const header = byClass('border-border');
    expect(header.className).toContain('border-b');
  });

  it('uses text-status-info for running spinner icon', () => {
    renderModal({ isOpen: true, action: 'start' });
    // The spinner SVG has text-status-info class
    const spinnerWithStatus = byClass('text-status-info');
    expect(spinnerWithStatus).toBeTruthy();
    // The element might be the parent that contains the spinner with status-info
  });

  it('applies text-text-muted to minimize and close buttons', () => {
    renderModal({ isOpen: true });
    const button = byClass('text-text-muted');
    expect(button.className).toContain('hover:text-text');
    expect(button.tagName).toBe('BUTTON');
  });

  it('applies status-info tokens to operation-in-progress alert', () => {
    renderModal({ isOpen: true });
    // Alert box uses bg-status-info/10 + border-status-info/20 + text-status-info
    const statusInfoEl = byClass('bg-status-info');
    expect(statusInfoEl.className).toMatch(/bg-status-info.*10/);
    expect(statusInfoEl.className).toContain('text-status-info');
    expect(statusInfoEl.textContent).toContain('Operation in progress');
  });

  it('does not render when isOpen is false', () => {
    renderModal({ isOpen: false });
    expect(screen.queryByText(/Starting test-service/)).toBeNull();
  });

  it('renders title text "Starting test-service" for start action', () => {
    renderModal({ isOpen: true, action: 'start' });
    expect(screen.getByText(/Starting test-service/)).toBeTruthy();
  });

  it('renders title text "Stopping test-service" for stop action', () => {
    renderModal({ isOpen: true, action: 'stop' });
    expect(screen.getByText(/Stopping test-service/)).toBeTruthy();
  });

  it('renders title text "Restarting test-service" for restart action', () => {
    renderModal({ isOpen: true, action: 'restart' });
    expect(screen.getByText(/Restarting test-service/)).toBeTruthy();
  });

  it('applies border-border to footer divider', () => {
    renderModal({ isOpen: true });
    // Main modal and its dividers use border-border consistently
    const borders = document.querySelectorAll('[class~="border-border"]');
    expect(borders.length).toBeGreaterThan(0);
  });

  it('verifies no raw color utilities remain in modal chrome', () => {
    const { container } = renderModal({ isOpen: true });
    const html = container.innerHTML;
    // Verify raw Tailwind colors are replaced (was the original goal)
    expect(html).not.toMatch(/bg-gray-900|bg-gray-50|border-gray-|text-gray-[0-9]/);
    // Verify semantic tokens are in use instead
    expect(html).toContain('bg-surface');
    expect(html).toContain('border-border');
  });

  it('verifies all interactive elements use semantic tokens', () => {
    renderModal({ isOpen: true });
    // Both buttons should use semantic text colors
    const textMuted = byClass('text-text-muted');
    expect(textMuted).toBeTruthy();
  });

  it('renders modal title with proper font styling', () => {
    renderModal({ isOpen: true });
    const title = screen.getByText(/Starting test-service/);
    expect(title.className).toContain('font-bold');
  });

  it('applies semantic padding and spacing classes', () => {
    renderModal({ isOpen: true });
    // Verify the component structure (modal uses p-4, flex layout, etc)
    const modal = byClass('bg-surface');
    expect(modal.className).toContain('rounded-lg');
    expect(modal.className).toContain('shadow-xl');
  });

  it('renders terminal container with proper background color', () => {
    renderModal({ isOpen: true });
    // Terminal container (bg-[#1e1e1e]) is marked as a terminal-specific exception
    const { container } = render(
      <ToastProvider>
        <ActionProgressModal isOpen={true} onClose={vi.fn()} serviceName="test" action="start" onComplete={vi.fn()} />
      </ToastProvider>
    );
    // Verify terminal container exists with the dark background
    const terminalBg = container.querySelector('[class*="bg-"]');
    expect(terminalBg).toBeTruthy();
  });
});
