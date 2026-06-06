/**
 * Responsive-layout regression guards (#806).
 *
 * Manual responsive QA across phone / tablet / laptop / wide-desktop
 * widths catches bugs no automated suite can — touch interactions,
 * font metrics, scroll behaviour at the edges. But there is a
 * predictable class of bugs that *is* catchable automatically:
 * "did someone delete the breakpoint utility from this component?"
 *
 * Each test below pins **one specific responsive behaviour** that has
 * regressed before. They run under jsdom and assert structural markers
 * (Tailwind utility classes, conditional rendering, viewport-resize
 * effects) — fast, deterministic, and they fail loudly if a refactor
 * silently drops mobile chrome. They do *not* replace browser QA.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Sidebar from '@/components/Sidebar';
import { MobileTopBar, MobileBottomBar } from '@/components/MobileNav';
import { ToastProvider } from '@/providers/ToastProvider';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/services',
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ push: mockPush, replace: mockPush }),
}));

// Sidebar consumes the digital twin (#1755 gates the Maintenance Chat link on
// installedTemplates). These structural tests render Sidebar bare, outside a
// DigitalTwinProvider, so stub the hook to a no-twin snapshot.
vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({ data: null, isConnected: false, lastUpdate: 0, isNodeSynced: () => false }),
}));

const withToast = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}

describe('Responsive layout guards (#806)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('Sidebar', () => {
    it('renders expanded at desktop widths (≥768px)', () => {
      setViewport(1280);
      render(<Sidebar />);
      // Expanded sidebar shows the full label, not just the icon.
      expect(screen.getByText('Services')).toBeDefined();
      expect(screen.getByTitle('Collapse Sidebar')).toBeDefined();
    });

    it('auto-collapses on first mount at mobile widths (<768px)', () => {
      setViewport(414);
      render(<Sidebar />);
      // Collapsed: no labels, only the expand toggle.
      expect(screen.queryByText('Services')).toBeNull();
      expect(screen.getByTitle('Expand Sidebar')).toBeDefined();
    });

    it('keeps the operator-collapsed state — re-expanding is explicit', async () => {
      setViewport(1280);
      render(<Sidebar />);
      // Operator collapses…
      fireEvent.click(screen.getByTitle('Collapse Sidebar'));
      await waitFor(() => {
        expect(screen.queryByText('Services')).toBeNull();
      });
      // … sidebar should NOT auto-re-expand on its own.
      expect(screen.getByTitle('Expand Sidebar')).toBeDefined();
    });
  });

  describe('MobileTopBar', () => {
    it('renders the md:hidden chrome class', () => {
      const { container } = withToast(<MobileTopBar />);
      const root = container.firstElementChild as HTMLElement | null;
      // md:hidden hides the mobile top bar on desktop — load-bearing
      // because the desktop sidebar already provides the same chrome.
      expect(root?.className).toMatch(/\bmd:hidden\b/);
    });

    it('exposes Settings via the touch-target row, never as a tappable label', () => {
      withToast(<MobileTopBar />);
      // Settings reaches the mobile user via the icon button, not by
      // adding clutter as a row in the bottom nav.
      expect(screen.getByLabelText('Open settings')).toBeDefined();
    });
  });

  describe('MobileBottomBar', () => {
    it('renders the md:hidden chrome class', () => {
      const { container } = withToast(<MobileBottomBar />);
      const root = container.firstElementChild as HTMLElement | null;
      expect(root?.className).toMatch(/\bmd:hidden\b/);
    });

    it('every nav button is a >= 32px touch target', () => {
      withToast(<MobileBottomBar />);
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);
      // Tailwind p-2 = 0.5rem ≈ 8px padding × 2 + 20px icon = 36px
      // tap area. We check the class shape rather than computed style
      // because jsdom doesn't lay out CSS.
      for (const btn of buttons) {
        expect(btn.className).toMatch(/\bp-2\b/);
      }
    });

    it('exposes every entry with a recognisable accessible name', () => {
      withToast(<MobileBottomBar />);
      // Every nav button must have aria-label / title so screen readers
      // and TalkBack can announce them at tap time on mobile.
      const buttons = screen.getAllByRole('button');
      for (const btn of buttons) {
        const label = btn.getAttribute('aria-label') || btn.getAttribute('title');
        expect(label).toBeTruthy();
        expect(label?.length ?? 0).toBeGreaterThan(0);
      }
    });
  });
});
