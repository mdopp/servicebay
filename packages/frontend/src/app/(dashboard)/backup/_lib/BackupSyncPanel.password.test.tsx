import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/providers/ToastProvider';
import BackupPage from '../page';

/**
 * The SMB share credential is write-only in the UI (#2771).
 *
 * `GET /api/settings/backup-sync` used to hand the live password back on every
 * Settings → Backup load, and `useBackupState` folded it straight into React
 * state and into the rendered input. The route now reports `hasPassword`; these
 * DOM cases pin the consumer side of that contract — the field renders empty,
 * the form says a password is stored, and a save that never touches the field
 * sends no password (which the route reads as "keep the stored secret").
 */

vi.mock('@servicebay/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@servicebay/api-client')>()),
  fetchNodes: vi.fn(async () => []),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

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

const syncRoutes = (hasPassword: boolean) => ({
  '/api/settings/backup-sync': () => ({
    config: {
      enabled: true,
      schedule: 'daily',
      time: '02:00',
      sources: [{ path: '/mnt/data', excludePatterns: [] }],
      // What the redacted GET now returns for an smb target: a flag, not a value.
      target: { type: 'smb', host: 'nas.local', share: 'backup', username: 'sb', hasPassword },
    },
    history: [],
    running: false,
  }),
  '/api/settings/backups': () => [],
  '/api/system/external-backup/list': () => ({ configured: false, connection: null, backups: [] }),
});

const renderPage = (hasPassword = true) => {
  const spy = mockFetch(syncRoutes(hasPassword));
  return { spy, ...render(<ToastProvider><BackupPage /></ToastProvider>) };
};

const passwordInput = async () =>
  (await screen.findByLabelText('Password')) as HTMLInputElement;

afterEach(() => vi.unstubAllGlobals());

describe('Backup Sync SMB password is write-only (#2771)', () => {
  it('renders the password field empty and says a password is stored', async () => {
    renderPage(true);
    const input = await passwordInput();
    expect(input.value).toBe('');
    expect(await screen.findByText(/A password is stored/i)).toBeTruthy();
  });

  it('says no password is stored when the box has none', async () => {
    renderPage(false);
    await passwordInput();
    expect(await screen.findByText(/No password stored/i)).toBeTruthy();
  });

  it('saves without a password when the operator never touches the field', async () => {
    const { spy } = renderPage(true);
    await passwordInput();
    fireEvent.click(await screen.findByText('Save'));

    await waitFor(() => {
      const save = spy.mock.calls.find(([input, init]) =>
        String(input).includes('/api/settings/backup-sync') && init?.method === 'POST');
      expect(save).toBeTruthy();
      const body = JSON.parse(String(save![1]?.body));
      expect(body.action).toBe('save');
      expect(body.config.target.type).toBe('smb');
      expect(body.config.target.password).toBeUndefined();
    });
  });

  it('sends a newly typed password on save', async () => {
    const { spy } = renderPage(true);
    fireEvent.change(await passwordInput(), { target: { value: 'rotated-pw' } });
    fireEvent.click(await screen.findByText('Save'));

    await waitFor(() => {
      const save = spy.mock.calls.find(([input, init]) =>
        String(input).includes('/api/settings/backup-sync') && init?.method === 'POST');
      expect(save).toBeTruthy();
      expect(JSON.parse(String(save![1]?.body)).config.target.password).toBe('rotated-pw');
    });
  });
});
