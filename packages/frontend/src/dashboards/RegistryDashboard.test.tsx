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

const { fetchTemplates, syncAllRegistries, addToast } = vi.hoisted(() => ({
  fetchTemplates: vi.fn(),
  syncAllRegistries: vi.fn(),
  addToast: vi.fn<(type: string, title: string, message?: string, duration?: number) => string>(
    () => 'toast-id',
  ),
}));

vi.mock('@/app/actions', () => ({ fetchTemplates, syncAllRegistries }));
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
    syncAllRegistries.mockReset().mockResolvedValue(undefined);
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
