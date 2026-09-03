import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/providers/ToastProvider';
import BackupPage from '../page';

/**
 * The #2743 god-module cut turned `backup/page.tsx` (1,851 LOC) into a thin
 * page that composes one component per backup backend plus a shared restore
 * flow. These tests pin the seams the split introduced — that every panel is
 * still mounted, that each one still drives ITS OWN backend route through the
 * handlers that moved with it, and that the cross-panel restore flow still
 * connects the System Snapshot panel to the overlay. Without them a panel could
 * silently stop being rendered and every existing test would stay green.
 */

vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  fetchNodes: vi.fn(async () => []),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

const storedBackup = {
  fileName: 'servicebay-2026-09-01.tar.gz',
  createdAt: '2026-09-01T00:00:00.000Z',
  size: 4096,
};

/** A preview payload rich enough to exercise both file accordions. */
const preview = {
  source: { type: 'stored', fileName: storedBackup.fileName },
  preview: {
    config: {
      nodes: [{ name: 'Local', uri: 'unix:///run/podman.sock', default: true }],
      checks: [{ id: 'chk-1', name: 'Portal reachable', type: 'http', target: 'https://x' }],
      externalLinks: [],
      registries: [],
      gateway: null,
      notifications: null,
      templateSettings: [],
      logLevel: null,
      update: null,
    },
    nodeFiles: [{
      nodeName: 'Local',
      files: [{ relativePath: 'media/media.kube', fileName: 'media.kube' }],
    }],
    serviceData: [{ name: 'home-assistant', files: ['configuration.yaml'] }],
  },
};

/** Fresh Response per call, dispatched by URL — never reuse a Response. */
function mockFetch(map: Record<string, () => unknown>) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = typeof input === 'string' ? input : input.toString();
    const key = Object.keys(map).find(k => url.includes(k));
    return new Response(JSON.stringify(key ? map[key]() : {}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ROUTES = {
  '/api/settings/backup-sync': () => ({
    config: {
      enabled: true,
      schedule: 'daily',
      time: '02:00',
      sources: [{ path: '/mnt/data', excludePatterns: [] }],
      target: { type: 'local', path: '/mnt/backup' },
    },
    history: [],
    running: false,
  }),
  '/api/settings/backups/preview': () => preview,
  '/api/settings/backups': () => [storedBackup],
  '/api/system/external-backup/backup-now': () => ({ backedUp: 1, total: 1, results: [{ ok: true }] }),
  '/api/system/external-backup/list': () => ({
    configured: true,
    connection: { ok: true },
    backups: [{ service: 'immich', tarName: 'immich-2026-09-01.tar.gz', size: 2048, createdAt: '2026-09-01T00:00:00.000Z' }],
  }),
};

const renderPage = () => {
  const spy = mockFetch(ROUTES);
  return { spy, ...render(<ToastProvider><BackupPage /></ToastProvider>) };
};

/** Every request URL the page has issued so far. */
const urls = (spy: ReturnType<typeof mockFetch>) =>
  spy.mock.calls.map(([input]) => (typeof input === 'string' ? input : String(input)));

afterEach(() => vi.unstubAllGlobals());

/**
 * Click the snapshot row's own "Restore". Scoped to that row on purpose: the
 * one-click "restore latest" CTA above the table and every NAS snapshot row
 * carry the same label but open confirm dialogs, not the overlay.
 */
async function openOverlayFromRow() {
  // The file name also appears in the "restore latest" CTA above the table, so
  // pick the occurrence that sits in a table row.
  const cells = await screen.findAllByText(storedBackup.fileName);
  const row = cells.map(c => c.closest('tr')).find(Boolean);
  expect(row).toBeTruthy();
  fireEvent.click(within(row!).getByText('Restore'));
}

describe('backup page — one panel per backend (#2743)', () => {
  it('mounts all three backend panels', async () => {
    renderPage();
    expect(await screen.findByText('System Snapshot')).toBeTruthy();
    expect(await screen.findByText('Snapshot on NAS')).toBeTruthy();
    expect(await screen.findByText('Backup Sync')).toBeTruthy();
  });

  it('the System Snapshot panel still drives the local tar route', async () => {
    const { spy } = renderPage();
    fireEvent.click(await screen.findByText('Create Snapshot'));
    await waitFor(() => {
      const posts = spy.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(posts.some(([input]) => String(input).includes('/api/settings/backups'))).toBe(true);
    });
  });

  it('the NAS panel still drives the external-backup route', async () => {
    const { spy } = renderPage();
    fireEvent.click(await screen.findByText('Back up now'));
    await waitFor(() => {
      expect(urls(spy).some(u => u.includes('/api/system/external-backup/backup-now'))).toBe(true);
    });
  });

  it('the Backup Sync panel still drives the backup-sync route', async () => {
    const { spy } = renderPage();
    fireEvent.click(await screen.findByText('Save'));
    await waitFor(() => {
      const saves = spy.mock.calls.filter(([input, init]) =>
        String(input).includes('/api/settings/backup-sync') && init?.method === 'POST');
      expect(saves.length).toBeGreaterThan(0);
      expect(String(saves[0][1]?.body)).toContain('"action":"save"');
    });
  });
});

describe('backup page — the shared restore flow (#2743)', () => {
  it('opens the overlay from the System Snapshot panel and renders both file accordions', async () => {
    renderPage();
    await openOverlayFromRow();

    const panel = await screen.findByText('Restore from Backup');
    expect(panel).toBeTruthy();
    // Both accordions are separate components now; both must still mount.
    expect(await screen.findByText('Systemd Files')).toBeTruthy();
    expect(await screen.findByText('Service Config')).toBeTruthy();
    expect(await screen.findByText('Restore Selected')).toBeTruthy();
  });

  it('expanding Systemd Files reveals the moved per-node selection UI', async () => {
    renderPage();
    await openOverlayFromRow();
    fireEvent.click(await screen.findByText('Systemd Files'));
    // The node row + its target picker live in RestoreSystemdFilesSection.
    expect(await screen.findByText('1/1 files')).toBeTruthy();
    expect(await screen.findByText('Target:')).toBeTruthy();
  });

  it('expanding Service Config reveals the moved per-service selection UI', async () => {
    renderPage();
    await openOverlayFromRow();
    fireEvent.click(await screen.findByText('Service Config'));
    // The service row lives in RestoreServiceDataSection; its category body in
    // RestoreServiceDataCategories.
    const row = await screen.findByText('home/assistant');
    expect(within(row.closest('div')!.parentElement!).getByText('1/1')).toBeTruthy();
  });

  it('expanding a service row renders its per-category file list', async () => {
    renderPage();
    await openOverlayFromRow();
    fireEvent.click(await screen.findByText('Service Config'));
    // Expanding the service row mounts RestoreServiceDataCategories, which owns
    // the per-category rows and the per-file checkboxes.
    fireEvent.click(await screen.findByText('home/assistant'));
    expect(await screen.findByText('Configuration')).toBeTruthy();
    fireEvent.click(await screen.findByText('Configuration'));
    expect(await screen.findByText('configuration.yaml')).toBeTruthy();
  });

  it('the Selective restore… button opens the overlay with the upload drop zone', async () => {
    renderPage();
    fireEvent.click((await screen.findAllByText('Selective restore…'))[0]);
    expect(await screen.findByText('Drop a backup archive here')).toBeTruthy();
  });
});
