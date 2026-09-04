import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TemplateUpgradesPendingBanner from './TemplateUpgradesPendingBanner';
import { ToastProvider } from '@/providers/ToastProvider';

// The banner reaches for the registry through Next server actions and can open
// the InstallerModal; neither is what these specs are about.
vi.mock('@/app/actions', () => ({
  fetchTemplates: vi.fn(async () => []),
  fetchReadme: vi.fn(async () => ''),
}));
vi.mock('./InstallerModal', () => ({ default: () => null }));

import { fetchTemplates } from '@/app/actions';

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

const pending = [
  { name: 'home-assistant', installedVersion: 7, currentVersion: 8, hasBreakingChange: false, sectionHeaders: [] },
  { name: 'media', installedVersion: 7, currentVersion: 8, hasBreakingChange: false, sectionHeaders: [] },
];

function mockPending() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(JSON.stringify({ pending, hasBreakingChange: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const renderBanner = () =>
  render(
    <ToastProvider>
      <TemplateUpgradesPendingBanner />
    </ToastProvider>,
  );

describe('TemplateUpgradesPendingBanner (#2604)', () => {
  let fetchSpy: ReturnType<typeof mockPending>;

  beforeEach(() => {
    localStorage.clear();
    setViewport(true);
    fetchSpy = mockPending();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    window.matchMedia = originalMatchMedia;
    localStorage.clear();
  });

  it('lists every pending upgrade on a desktop viewport', async () => {
    renderBanner();
    expect(await screen.findByText(/2 template upgrades available/i)).not.toBeNull();
    expect(screen.getByText('home-assistant')).not.toBeNull();
    expect(screen.getByText('media')).not.toBeNull();
  });

  it('collapses the per-template rows on a phone but keeps the count on screen', async () => {
    setViewport(false);
    renderBanner();
    expect(await screen.findByText(/2 template upgrades available/i)).not.toBeNull();
    expect(screen.queryByText('home-assistant')).toBeNull();

    fireEvent.click(screen.getByTestId('template-upgrades-notice-toggle'));
    expect(screen.getByText('home-assistant')).not.toBeNull();
  });

  it('collapsing never hides a pending upgrade — the summary line survives a reload', async () => {
    const first = renderBanner();
    await screen.findByText(/2 template upgrades available/i);

    fireEvent.click(screen.getByTestId('template-upgrades-notice-toggle'));
    expect(screen.queryByText('home-assistant')).toBeNull();
    first.unmount();

    // A fresh mount reads the remembered choice back: rows stay folded, but the
    // pending count is still there to be found (the old `×` removed it outright).
    renderBanner();
    expect(await screen.findByText(/2 template upgrades available/i)).not.toBeNull();
    expect(screen.queryByText('home-assistant')).toBeNull();

    fireEvent.click(screen.getByTestId('template-upgrades-notice-toggle'));
    expect(screen.getByText('home-assistant')).not.toBeNull();
  });

  it('re-expands by itself when a newly published upgrade appears', async () => {
    localStorage.setItem(
      'sb_template_upgrades_dismissed',
      JSON.stringify(['home-assistant@8', 'media@8']),
    );
    fetchSpy.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          pending: [
            ...pending,
            { name: 'immich', installedVersion: 3, currentVersion: 4, hasBreakingChange: false, sectionHeaders: [] },
          ],
          hasBreakingChange: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    renderBanner();
    await waitFor(() => expect(screen.getByText('immich')).not.toBeNull());
  });

  // sb/no-raw-ui-primitive sweep: each row's "Update & restart" action now
  // renders through the shared Button primitive (@/components/ui) instead
  // of a raw <button>. Assert it's still a real BUTTON (tagName +
  // data-variant) and that clicking it still drives the same
  // openInstaller flow (fetchTemplates lookup by name).
  it('renders the row action as a ui Button and still opens the installer flow on click', async () => {
    renderBanner();
    await screen.findByText(/2 template upgrades available/i);

    const [firstButton] = screen.getAllByRole('button', { name: /Update & restart/i });
    expect(firstButton.tagName).toBe('BUTTON');
    expect(firstButton.getAttribute('data-variant')).toBe('primary');

    fireEvent.click(firstButton);
    await waitFor(() => expect(fetchTemplates).toHaveBeenCalled());
  });
});
