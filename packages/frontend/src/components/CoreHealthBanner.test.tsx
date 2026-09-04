import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CoreHealthBanner from './CoreHealthBanner';
import { useCoreHealth } from '@/hooks/useCoreHealth';

vi.mock('@/hooks/useCoreHealth', () => ({ useCoreHealth: vi.fn() }));

const DISMISS_KEY = 'sb:core-health-banner-dismissed';

const DEGRADED = [
  {
    stack: 'media',
    label: 'Media',
    notReady: [{ template: 'media-jellyfin', state: 'unhealthy' as const }],
  },
];

describe('CoreHealthBanner', () => {
  beforeEach(() => {
    sessionStorage.removeItem(DISMISS_KEY);
    vi.mocked(useCoreHealth).mockReturnValue({
      degraded: DEGRADED,
      unhealthy: true,
      labels: ['Media'],
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the dismiss control is a Button primitive that hides the banner and persists the dismissal', () => {
    render(<CoreHealthBanner />);
    expect(screen.getByText(/Core stack unhealthy: Media/)).toBeTruthy();

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    expect(dismissBtn.tagName).toBe('BUTTON');
    expect(dismissBtn.getAttribute('data-variant')).toBe('ghost');

    fireEvent.click(dismissBtn);
    expect(screen.queryByText(/Core stack unhealthy: Media/)).toBeNull();
    expect(sessionStorage.getItem(DISMISS_KEY)).toBe('1');
  });

  it('stays dismissed across a remount within the same session', () => {
    sessionStorage.setItem(DISMISS_KEY, '1');
    render(<CoreHealthBanner />);
    expect(screen.queryByText(/Core stack unhealthy/)).toBeNull();
  });
});
