/**
 * RestoreStatusBanner — Button primitive swap (no-raw-ui-primitive sweep).
 *
 * The dismiss control moved off a raw `<button>` onto the shared
 * `<Button variant="ghost">` primitive from `@/components/ui`; the
 * component had no test at all, so that swap shipped with zero coverage.
 * These tests render the active banner and exercise the dismiss control
 * the swap touches.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchReinstallStatusMock = vi.fn();
const dismissReinstallBannerMock = vi.fn();
const fetchServiceSummariesMock = vi.fn();

vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  fetchReinstallStatus: (...args: unknown[]) => fetchReinstallStatusMock(...args),
  dismissReinstallBanner: (...args: unknown[]) => dismissReinstallBannerMock(...args),
  fetchServiceSummaries: (...args: unknown[]) => fetchServiceSummariesMock(...args),
}));

import RestoreStatusBanner from './RestoreStatusBanner';

describe('RestoreStatusBanner — Button primitive swap (#no-raw-ui-primitive)', () => {
  beforeEach(() => {
    fetchReinstallStatusMock.mockReset();
    dismissReinstallBannerMock.mockReset().mockResolvedValue({ ok: true });
    fetchServiceSummariesMock.mockReset();
  });

  it('renders nothing while inactive/loading', async () => {
    fetchReinstallStatusMock.mockResolvedValue({ active: false });
    fetchServiceSummariesMock.mockResolvedValue([]);

    const { container } = render(<RestoreStatusBanner />);
    await waitFor(() => expect(fetchReinstallStatusMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it('renders the dismiss control as a real Button and dismissing hides the banner', async () => {
    fetchReinstallStatusMock.mockResolvedValue({ active: true, minutesRemaining: 5 });
    fetchServiceSummariesMock.mockResolvedValue([
      { isManaged: true, active: true },
      { isManaged: true, active: false },
    ]);

    const { container } = render(<RestoreStatusBanner />);

    const dismissBtn = await waitFor(() => screen.getByRole('button', { name: 'Dismiss' }));
    expect(dismissBtn.tagName).toBe('BUTTON');
    expect(dismissBtn.getAttribute('data-variant')).toBe('ghost');

    fireEvent.click(dismissBtn);

    await waitFor(() => expect(dismissReinstallBannerMock).toHaveBeenCalled());
    await waitFor(() => expect(container.firstChild).toBeNull());
  });
});
