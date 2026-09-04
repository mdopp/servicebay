/**
 * ReverseProxyConfig — Button primitive swap (no-raw-ui-primitive sweep, 0c9e214d).
 *
 * The header's refresh icon action and the "Install Nginx" call-to-action
 * moved off raw `<button>` onto the shared `<Button>` primitive from
 * `@/components/ui`; the component had no test at all, so that swap shipped
 * with zero coverage. These tests render the not-installed state (where both
 * swapped buttons are reachable), assert each is a real `<button>`, and click
 * them to exercise `checkStatus` and `handleInstall`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchNginxStatusMock = vi.fn();
const installNginxMock = vi.fn();
vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  fetchNginxStatus: (...args: unknown[]) => fetchNginxStatusMock(...args),
  installNginx: (...args: unknown[]) => installNginxMock(...args),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import ReverseProxyConfig from './ReverseProxyConfig';
import { ToastProvider } from '@/providers/ToastProvider';

function renderPanel() {
  return render(
    <ToastProvider>
      <ReverseProxyConfig />
    </ToastProvider>,
  );
}

describe('ReverseProxyConfig — Button primitive swap (#no-raw-ui-primitive)', () => {
  beforeEach(() => {
    fetchNginxStatusMock.mockReset();
    installNginxMock.mockReset();
  });

  it('renders the header refresh action as a real Button and re-checks status on click', async () => {
    fetchNginxStatusMock.mockResolvedValue({ installed: false });
    renderPanel();

    await waitFor(() => expect(fetchNginxStatusMock).toHaveBeenCalledTimes(1));
    await screen.findByText('Nginx is not installed on this system');

    // Icon-only ghost Button — no accessible name, so it's the first button
    // in document order (header refresh precedes the install CTA).
    const refreshButton = screen.getAllByRole('button')[0];
    expect(refreshButton.tagName).toBe('BUTTON');
    expect(refreshButton.getAttribute('type')).toBe('button');

    fireEvent.click(refreshButton);
    await waitFor(() => expect(fetchNginxStatusMock).toHaveBeenCalledTimes(2));
  });

  it('renders "Install Nginx" as a primary Button and clicking it installs + re-checks status', async () => {
    fetchNginxStatusMock.mockResolvedValue({ installed: false });
    installNginxMock.mockResolvedValue({ success: true });
    renderPanel();

    const installButton = await screen.findByRole('button', { name: /Install Nginx/i });
    expect(installButton.tagName).toBe('BUTTON');
    expect(installButton.getAttribute('type')).toBe('button');

    fireEvent.click(installButton);

    await waitFor(() => expect(installNginxMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Nginx installed successfully')).toBeTruthy();
    // handleInstall re-checks status on success.
    await waitFor(() => expect(fetchNginxStatusMock).toHaveBeenCalledTimes(2));
  });

  it('shows an error toast when install fails, without crashing the panel', async () => {
    fetchNginxStatusMock.mockResolvedValue({ installed: false });
    installNginxMock.mockRejectedValue(new Error('boom'));
    renderPanel();

    const installButton = await screen.findByRole('button', { name: /Install Nginx/i });
    fireEvent.click(installButton);

    expect(await screen.findByText('Failed to install Nginx')).toBeTruthy();
  });
});
