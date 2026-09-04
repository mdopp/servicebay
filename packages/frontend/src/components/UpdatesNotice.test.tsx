import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import UpdatesNotice from './UpdatesNotice';

/**
 * #2604 — the update notices used to stack full-height above the service
 * list and push it off a phone screen. The contract pinned here:
 *
 *  - the summary line (which carries the count) is ALWAYS rendered, so a
 *    collapse can never hide a pending update;
 *  - the detail rows default to collapsed below `md` and expanded from `md`
 *    up, so the desktop reading is unchanged;
 *  - the toggle works in both directions on both viewports.
 */
const originalMatchMedia = window.matchMedia;

function setViewport(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide && query.includes('min-width'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const notice = (props: Partial<React.ComponentProps<typeof UpdatesNotice>> = {}) => (
  <UpdatesNotice title="2 updates available" {...props}>
    <p>detail-row</p>
  </UpdatesNotice>
);

describe('UpdatesNotice (#2604)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('collapses the detail rows on a phone viewport but keeps the summary line', () => {
    setViewport(false);
    render(notice());
    expect(screen.getByText('2 updates available')).not.toBeNull();
    expect(screen.queryByText('detail-row')).toBeNull();
    const toggle = screen.getByTestId('updates-notice-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('data-variant')).toBe('ghost');
  });

  it('stays expanded on a desktop viewport (no phone fix at the desktop’s expense)', () => {
    setViewport(true);
    render(notice());
    expect(screen.getByText('detail-row')).not.toBeNull();
    expect(screen.getByTestId('updates-notice-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('expands on tap on a phone and reports the new state', () => {
    setViewport(false);
    const onToggle = vi.fn();
    render(notice({ onToggle }));

    fireEvent.click(screen.getByTestId('updates-notice-toggle'));

    expect(screen.getByText('detail-row')).not.toBeNull();
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('collapses on click on a desktop and reports the new state', () => {
    setViewport(true);
    const onToggle = vi.fn();
    render(notice({ onToggle }));

    fireEvent.click(screen.getByTestId('updates-notice-toggle'));

    expect(screen.queryByText('detail-row')).toBeNull();
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('honours a remembered collapse on desktop — and still shows the summary', () => {
    setViewport(true);
    render(notice({ defaultCollapsed: true }));
    expect(screen.queryByText('detail-row')).toBeNull();
    // The count never disappears: a remembered collapse is not a dismissal.
    expect(screen.getByText('2 updates available')).not.toBeNull();
  });

  it('keeps the primary action reachable while collapsed', () => {
    setViewport(false);
    render(notice({ action: <button type="button">Update now</button> }));
    expect(screen.queryByText('detail-row')).toBeNull();
    expect(screen.getByRole('button', { name: /update now/i })).not.toBeNull();
  });
});
