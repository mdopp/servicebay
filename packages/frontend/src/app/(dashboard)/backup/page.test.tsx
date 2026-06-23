import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/providers/ToastProvider';
import BackupPage from './page';

// The backup app loads its node list via the getNodes server action; stub it so
// the page can render without a live backend.
vi.mock('@/app/actions/nodes', () => ({
  getNodes: () => Promise.resolve([]),
}));

// PageHeader calls useRouter(); the app router isn't mounted under bare render().
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

/** Fresh Response per call, dispatched by URL (memory: never reuse a Response). */
function mockFetchByUrl(map: Record<string, () => unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = Object.keys(map).find(k => url.includes(k));
    const body = key ? map[key]() : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

/** A backup-sync config the page's fetchBackupSync() folds into state. */
const syncConfig = (enabled: boolean) => ({
  config: {
    enabled,
    schedule: 'daily',
    time: '02:00',
    sources: [{ path: '/mnt/data', excludePatterns: [] }],
    target: { type: 'local', path: '/mnt/backup' },
    lastRun: '2026-06-05T01:00:00.000Z',
    lastStatus: 'success',
    lastDuration: 12,
  },
  history: [],
  running: false,
});

const renderPage = (enabled: boolean) => {
  vi.stubGlobal('fetch', mockFetchByUrl({
    '/api/settings/backup-sync': () => syncConfig(enabled),
    '/api/settings/backups': () => [],
    'external-backup': () => ({}),
  }));
  return render(<ToastProvider><BackupPage /></ToastProvider>);
};

/** N synthetic NAS snapshots, newest-first by stamp index. */
const nasBackups = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    service: `svc-${i}`,
    tarName: `svc-${i}-2026-06-${String(20 - (i % 20)).padStart(2, '0')}.tar.gz`,
    size: 1024,
    createdAt: `2026-06-${String(20 - (i % 20)).padStart(2, '0')}T00:00:00.000Z`,
  }));

const renderWithNas = (count: number) => {
  vi.stubGlobal('fetch', mockFetchByUrl({
    '/api/settings/backup-sync': () => syncConfig(false),
    '/api/settings/backups': () => [],
    '/api/system/external-backup/list': () => ({
      configured: true,
      connection: { ok: true },
      backups: nasBackups(count),
    }),
    'external-backup': () => ({}),
  }));
  return render(<ToastProvider><BackupPage /></ToastProvider>);
};

describe('BackupsSettingsPage — Backup Sync collapse', () => {
  beforeEach(() => {
    // jsdom lacks scrollIntoView etc.; nothing else to seed.
  });
  afterEach(() => vi.unstubAllGlobals());

  it('collapses to header + toggle + last-run when disabled (no config body in DOM)', async () => {
    renderPage(false);

    // Header row stays: title, the enable toggle (Disabled label), last-run line.
    expect(await screen.findByText('Backup Sync')).toBeDefined();
    await waitFor(() => expect(screen.getByText('Disabled')).toBeDefined());
    expect(screen.getByText(/Last run:/)).toBeDefined();

    // Config body is gone: source dirs, target picker, schedule, action buttons.
    expect(screen.queryByText('Source Directories')).toBeNull();
    expect(screen.queryByText(/Run Now/)).toBeNull();
    expect(screen.queryByText('Test Connection')).toBeNull();
  });

  it('shows the full config body when enabled', async () => {
    renderPage(true);

    await waitFor(() => expect(screen.getByText('Enabled')).toBeDefined());

    // Config body is present: source dirs, schedule, action buttons.
    expect(screen.getByText('Source Directories')).toBeDefined();
    expect(screen.getByText(/Run Now/)).toBeDefined();
    expect(screen.getByText('Test Connection')).toBeDefined();
  });

  it('toggling enable only flips display — it does not persist config', async () => {
    renderPage(false);
    await waitFor(() => expect(screen.getByText('Disabled')).toBeDefined());

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const writeCallsBefore = fetchMock.mock.calls.filter(c =>
      String(c[1] && (c[1] as RequestInit).method).toUpperCase() === 'POST' ||
      String(c[1] && (c[1] as RequestInit).method).toUpperCase() === 'PUT');

    // Flip the toggle on. The config body should now appear...
    const toggle = screen.getByText('Disabled').closest('label')!.querySelector('input[type="checkbox"]')!;
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText('Source Directories')).toBeDefined());

    // ...but no persist (POST/PUT to backup-sync) was triggered by the toggle itself.
    const writeCallsAfter = fetchMock.mock.calls.filter(c =>
      String(c[1] && (c[1] as RequestInit).method).toUpperCase() === 'POST' ||
      String(c[1] && (c[1] as RequestInit).method).toUpperCase() === 'PUT');
    expect(writeCallsAfter.length).toBe(writeCallsBefore.length);
  });
});

describe('BackupsSettingsPage — NAS snapshot list collapse (#2085)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('caps the NAS snapshot list to the newest 5 with a "show all" expander', async () => {
    renderWithNas(12);

    // The newest 5 services render; the older ones are hidden behind the cap.
    expect(await screen.findByText('svc-0')).toBeDefined();
    expect(screen.getByText('svc-4')).toBeDefined();
    expect(screen.queryByText('svc-5')).toBeNull();
    expect(screen.queryByText('svc-11')).toBeNull();

    // Expander advertises the full count.
    const expander = screen.getByText('Show all 12 snapshots');

    // Expand → every snapshot is now in the DOM.
    fireEvent.click(expander);
    await waitFor(() => expect(screen.getByText('svc-11')).toBeDefined());
    expect(screen.getByText('svc-5')).toBeDefined();

    // Collapse again → back to the capped view, older rows gone.
    fireEvent.click(screen.getByText('Show fewer (newest 5)'));
    await waitFor(() => expect(screen.queryByText('svc-11')).toBeNull());
  });

  it('shows no expander when the NAS snapshot list fits within the cap', async () => {
    renderWithNas(3);

    expect(await screen.findByText('svc-0')).toBeDefined();
    expect(screen.getByText('svc-2')).toBeDefined();
    expect(screen.queryByText(/Show all/)).toBeNull();
  });
});

describe('BackupsSettingsPage — design-system migration (#2100 ds-migrate-shell)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('section cards use token surfaces — no raw bg-white/dark:bg-gray-800 chrome', async () => {
    renderPage(false);
    // The System Snapshot section card is a token surface.
    const heading = await screen.findByText('System Snapshot');
    const card = heading.closest('.bg-surface');
    expect(card).not.toBeNull();
    expect(card!.className).toContain('border-border');
    expect(card!.className).not.toMatch(/bg-white|dark:bg-gray-800/);
  });

  it('action buttons render via the Button primitive (data-variant present)', async () => {
    renderPage(false);
    const create = await screen.findByText('Create Snapshot');
    const btn = create.closest('button')!;
    // The migrated Create Snapshot is a <Button> (carries data-variant).
    expect(btn.getAttribute('data-variant')).toBeTruthy();
  });

  it('Create Snapshot still streams a backup (behavior preserved)', async () => {
    renderPage(false);
    const create = await screen.findByText('Create Snapshot');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fireEvent.click(create.closest('button')!);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          c => String(c[0]).includes('/api/settings/backups') &&
            String((c[1] as RequestInit)?.method).toUpperCase() === 'POST',
        ),
      ).toBe(true),
    );
  });
});
