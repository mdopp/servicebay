/**
 * RegistryDashboard — load/sync failures must be visible (#2462).
 *
 * `loadData`/`handleSync` used to be try/finally with no catch: a rejected
 * fetchTemplates()/syncAllRegistries() reset the loading flag and left the
 * operator staring at an empty registry with no clue anything failed, unlike
 * every sibling dashboard which reports fetch errors via `addToast`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { fetchTemplates, syncAllRegistries, fetchStalledRegistries, addToast } = vi.hoisted(() => ({
  fetchTemplates: vi.fn(),
  syncAllRegistries: vi.fn(),
  fetchStalledRegistries: vi.fn(),
  addToast: vi.fn<(type: string, title: string, message?: string, duration?: number) => string>(
    () => 'toast-id',
  ),
}));

vi.mock('@/app/actions', () => ({ fetchTemplates, syncAllRegistries, fetchStalledRegistries }));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast, updateToast: vi.fn(), removeToast: vi.fn() }),
}));
// RegistryBrowser drags in the installer modals + react-markdown; the registry
// chrome is what's under test here.
vi.mock('@/components/RegistryBrowser', () => ({ __esModule: true, default: () => <div>browser</div> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

import RegistryDashboard from './RegistryDashboard';

describe('RegistryDashboard error reporting (#2462)', () => {
  beforeEach(() => {
    addToast.mockClear();
    fetchTemplates.mockReset().mockResolvedValue([]);
    syncAllRegistries.mockReset().mockResolvedValue({ requested: 1, synced: 1, failed: 0, skipped: 0, results: [] });
    fetchStalledRegistries.mockReset().mockResolvedValue([]);
  });

  it('reports a failed template load with an error toast', async () => {
    fetchTemplates.mockRejectedValue(new Error('registry unreachable'));
    render(<RegistryDashboard />);

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    const [type, title, message] = addToast.mock.calls[0];
    expect(type).toBe('error');
    expect(title).toMatch(/Failed to load registry/i);
    expect(message).toMatch(/registry unreachable/);
    // The spinner still clears — the point is that it doesn't clear silently.
    await waitFor(() => expect(screen.getByText('browser')).toBeTruthy());
  });

  it('reports a failed sync with an error toast', async () => {
    syncAllRegistries.mockRejectedValue(new Error('git fetch denied'));
    render(<RegistryDashboard />);
    await waitFor(() => expect(screen.getByText('browser')).toBeTruthy());
    addToast.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Sync Registries/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    const [type, title, message] = addToast.mock.calls[0];
    expect(type).toBe('error');
    expect(title).toMatch(/Registry sync failed/i);
    expect(message).toMatch(/git fetch denied/);
    // Button re-enabled for a retry, not stuck on "Syncing...".
    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Sync Registries/i }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('stays quiet when load and sync both succeed', async () => {
    render(<RegistryDashboard />);
    await waitFor(() => expect(screen.getByText('browser')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Sync Registries/i }));
    await waitFor(() => expect(syncAllRegistries).toHaveBeenCalled());
    await waitFor(() => expect(fetchTemplates).toHaveBeenCalledTimes(2));
    expect(addToast).not.toHaveBeenCalled();
  });
});

/**
 * #2610 — "Sync Registries" used to end silently whether two of two, one of two
 * or none of the configured registries actually cloned. A registry the box has
 * no credentials for never syncs, and the operator was never told.
 */
describe('RegistryDashboard registry-sync honesty (#2610)', () => {
  const stalled = [
    {
      name: 'ServiceBay Templates',
      url: 'https://github.com/mdopp/servicebay-templates',
      consecutiveFailures: 4,
      reason: 'the repository is private and this box has no credentials for it',
      advice: 'Make the repository public, or remove the registry in Settings.',
    },
  ];

  beforeEach(() => {
    addToast.mockClear();
    fetchTemplates.mockReset().mockResolvedValue([]);
    syncAllRegistries.mockReset().mockResolvedValue({ requested: 2, synced: 2, failed: 0, skipped: 0, results: [] });
    fetchStalledRegistries.mockReset().mockResolvedValue([]);
  });

  it('names the fraction that refreshed when one registry did not', async () => {
    syncAllRegistries.mockResolvedValue({
      requested: 2,
      synced: 1,
      failed: 1,
      skipped: 0,
      results: [
        { name: 'solbay', url: 'https://github.com/mdopp/solarisbay', status: 'synced' },
        {
          name: 'ServiceBay Templates',
          url: 'https://github.com/mdopp/servicebay-templates',
          status: 'failed',
          reason: 'the repository is private and this box has no credentials for it',
          advice: 'Make the repository public, or remove the registry in Settings.',
        },
      ],
    });
    render(<RegistryDashboard />);
    await waitFor(() => expect(screen.getByText('browser')).toBeTruthy());
    addToast.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Sync Registries/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    const [type, title, message] = addToast.mock.calls[0];
    expect(type).toBe('warning');
    // The denominator is in the title — "refreshed" can never be read as "all".
    expect(title).toBe('Refreshed 1 of 2 registries');
    expect(message).toMatch(/ServiceBay Templates/);
    expect(message).toMatch(/private and this box has no credentials/);
  });

  it('shows a registry that stopped syncing, with the reason, on page load', async () => {
    fetchStalledRegistries.mockResolvedValue(stalled);
    render(<RegistryDashboard />);

    const banner = await screen.findByRole('status');
    expect(banner.textContent).toMatch(/1 of the configured registries is not syncing/);
    expect(banner.textContent).toMatch(/ServiceBay Templates/);
    expect(banner.textContent).toMatch(/private and this box has no credentials/);
    // How many attempts were spent, that it keeps trying on its own (#2809), and what to do about it.
    expect(banner.textContent).toMatch(/4 failed attempts so far; ServiceBay retries on its own after a cooldown/);
    expect(banner.textContent).toMatch(/Make the repository public/);
    expect(banner.textContent).toMatch(/press Sync Registries/i);
  });

  it('shows no banner when every registry syncs', async () => {
    render(<RegistryDashboard />);
    await waitFor(() => expect(screen.getByText('browser')).toBeTruthy());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays quiet on a clean sync — no toast claiming anything', async () => {
    render(<RegistryDashboard />);
    await waitFor(() => expect(screen.getByText('browser')).toBeTruthy());
    addToast.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Sync Registries/i }));
    await waitFor(() => expect(syncAllRegistries).toHaveBeenCalled());
    await waitFor(() => expect(fetchTemplates).toHaveBeenCalledTimes(2));
    expect(addToast).not.toHaveBeenCalled();
  });
});
