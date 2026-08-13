/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Settings → Saved credentials (#2519).
 *
 * The acceptance criterion this file encodes: the section must stop being
 * a password table. No Password column, no reveal, no copy — a sync-status
 * line plus a Vaultwarden deep link instead, and an explicit "not yet
 * secured" marking whenever ServiceBay is still the only copy (including
 * the Vaultwarden-not-installed case).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CredentialsSection from '@/app/(dashboard)/settings/_lib/sections/CredentialsSection';

vi.mock('@/providers/ToastProvider', () => {
  const addToast = vi.fn();
  return { useToast: () => ({ addToast }) };
});

const VAULT_HOST = { service: 'vaultwarden', domain: 'vault.dopp.cloud' };

const UNSECURED = {
  service: 'Immich',
  url: 'http://localhost:2283',
  username: 'admin@dopp.cloud',
  password: 'sup3r-s3cret-value',
  importance: 'critical' as const,
  template: 'immich',
};
const SECURED = {
  service: 'LLDAP',
  url: 'https://ldap.dopp.cloud',
  username: 'admin',
  password: '',
  importance: 'critical' as const,
  template: 'auth',
  securedAt: '2026-08-12T09:00:00.000Z',
};

interface FetchHandler {
  pattern: RegExp;
  responder: (init?: RequestInit) => Promise<Response>;
}

function jsonRes(body: any, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

function installFetch(handlers: FetchHandler[]) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const h of handlers) {
      if (h.pattern.test(url)) return h.responder(init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as any;
}

/** Automated-push status the GET route now carries (#2519). */
const VAULT_READY = { installed: true, configured: true, lastSync: null };
const VAULT_NOT_SET_UP = { installed: true, configured: false, lastSync: null };
const VAULT_ABSENT = { installed: false, configured: false, lastSync: null };

function manifestFetch(
  credentials: any[],
  proxyHosts = [VAULT_HOST],
  vault: any = VAULT_NOT_SET_UP,
  sync?: { result: any; after: any[]; vaultAfter?: any },
) {
  // The section re-reads GET after a push, so the state is mutable.
  const state = { credentials, vault };
  installFetch([
    {
      pattern: /\/api\/system\/credentials\/secured$/,
      responder: () => jsonRes({ ok: true, secured: 1, securedAt: '2026-08-13T12:00:00.000Z' }),
    },
    {
      pattern: /\/api\/system\/credentials\/vault$/,
      responder: () => jsonRes({ ok: true, configured: true }),
    },
    {
      pattern: /\/api\/system\/credentials\/sync$/,
      responder: () => {
        if (sync) {
          state.credentials = sync.after;
          if (sync.vaultAfter) state.vault = sync.vaultAfter;
        }
        return jsonRes(sync?.result ?? { ok: true, attempted: 0, secured: 0 });
      },
    },
    {
      pattern: /\/api\/system\/credentials$/,
      responder: () => jsonRes({
        manifest: { savedAt: '2026-08-12T08:00:00.000Z', credentials: state.credentials },
        proxyHosts,
        publicDomain: 'dopp.cloud',
        vault: state.vault,
      }),
    },
  ]);
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CredentialsSection (#2519)', () => {
  it('renders no password column and never puts a stored secret in the DOM', async () => {
    manifestFetch([UNSECURED, SECURED]);
    const { container } = render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    expect(screen.queryByRole('columnheader', { name: /password/i })).toBeNull();
    expect(container.textContent).not.toContain('sup3r-s3cret-value');
    // The old reveal/copy affordances are gone with the column.
    expect(screen.queryByTitle(/reveal password/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^copy$/i })).toBeNull();
    // …replaced by a "where does this live" column.
    expect(screen.getByRole('columnheader', { name: /stored in/i })).toBeTruthy();
  });

  it('marks entries ServiceBay still holds as not yet secured', async () => {
    manifestFetch([UNSECURED, SECURED]);
    const { container } = render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    expect(screen.getByTestId('credentials-sync-status').textContent)
      .toMatch(/1 of 2 not yet secured/i);
    // Per-row chips: one warn ("Not yet secured"), one ok ("Vaultwarden").
    const warn = container.querySelectorAll('[data-variant="warn"]');
    const ok = container.querySelectorAll('[data-variant="ok"]');
    expect(warn).toHaveLength(1);
    expect(warn[0].textContent).toMatch(/not yet secured/i);
    expect(ok).toHaveLength(1);
    expect(ok[0].textContent).toBe('Vaultwarden');
  });

  it('shows the sync status and a Vaultwarden deep link once everything is secured', async () => {
    manifestFetch([SECURED]);
    render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('LLDAP')).toBeTruthy());

    const status = screen.getByTestId('credentials-sync-status');
    expect(status.textContent).toMatch(/All 1 entries are in Vaultwarden/i);
    expect(status.textContent).toMatch(/no longer stores these passwords/i);
    const link = screen.getByRole('link', { name: /open in vaultwarden/i }) as HTMLAnchorElement;
    expect(link.href).toContain('vault.dopp.cloud');
    // Nothing left to hand off.
    expect(screen.queryByRole('button', { name: /download csv/i })).toBeNull();
  });

  it('says so when Vaultwarden is not installed — the failure path stays visibly unsecured', async () => {
    manifestFetch([UNSECURED], [], VAULT_ABSENT);
    render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    expect(screen.getByTestId('credentials-sync-status').textContent).toMatch(/not yet secured/i);
    expect(screen.getByTestId('credentials-push-state').textContent).toMatch(/isn’t installed/i);
    expect(screen.queryByRole('link', { name: /vaultwarden/i })).toBeNull();
    // No push offered when there's nothing to push to…
    expect(screen.queryByRole('button', { name: /push to vaultwarden/i })).toBeNull();
    // …but the CSV escape hatch stays, so the operator is not stuck.
    expect(screen.getByRole('button', { name: /download csv/i })).toBeTruthy();
  });

  it('says the push is not set up when ServiceBay has no vault account', async () => {
    manifestFetch([UNSECURED], [VAULT_HOST], VAULT_NOT_SET_UP);
    render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    expect(screen.getByTestId('credentials-push-state').textContent).toMatch(/not set up/i);
    expect(screen.queryByRole('button', { name: /push to vaultwarden/i })).toBeNull();
  });

  it('pushes on demand and marks only what the vault confirmed', async () => {
    manifestFetch([UNSECURED], [VAULT_HOST], VAULT_READY, {
      result: { ok: true, attempted: 1, secured: 1, at: '2026-08-13T12:00:00.000Z' },
      after: [{ ...UNSECURED, password: '', securedAt: '2026-08-13T12:00:00.000Z' }],
      vaultAfter: { installed: true, configured: true, lastSync: { at: '2026-08-13T12:00:00.000Z', ok: true, secured: 1, attempted: 1 } },
    });
    const { container } = render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /push to vaultwarden/i }));

    await waitFor(() =>
      expect(screen.getByTestId('credentials-sync-status').textContent)
        .toMatch(/All 1 entries are in Vaultwarden/i));
    expect(container.textContent).not.toMatch(/not yet secured/i);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/system/credentials/sync',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('offers the setup form and posts the account write-only', async () => {
    manifestFetch([UNSECURED], [VAULT_HOST], VAULT_NOT_SET_UP);
    render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /set up automatic push/i }));
    fireEvent.change(screen.getByLabelText(/account e-mail/i), { target: { value: 'servicebay@dopp.cloud' } });
    fireEvent.change(screen.getByLabelText(/master password/i), { target: { value: 'generated-master-pw' } });
    fireEvent.change(screen.getByLabelText(/organization id/i), { target: { value: 'org-1' } });
    fireEvent.change(screen.getByLabelText(/collection id/i), { target: { value: 'col-1' } });
    // The secret is a password input — never rendered as readable text.
    expect((screen.getByLabelText(/master password/i) as HTMLInputElement).type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: /save vault account/i }));

    await waitFor(() => {
      const call = (global.fetch as any).mock.calls.find((c: any[]) => c[0] === '/api/system/credentials/vault');
      expect(call).toBeTruthy();
      expect(JSON.parse(call[1].body)).toMatchObject({ accountEmail: 'servicebay@dopp.cloud', organizationId: 'org-1' });
    });
  });

  it('a failed push leaves the entry marked not yet secured, with the reason', async () => {
    manifestFetch([UNSECURED], [VAULT_HOST], VAULT_READY, {
      result: {
        ok: false, attempted: 1, secured: 0, reason: 'unreachable',
        message: 'connect ECONNREFUSED', at: '2026-08-13T12:00:00.000Z',
      },
      // Server kept the password — nothing was confirmed.
      after: [UNSECURED],
      vaultAfter: {
        installed: true, configured: true,
        lastSync: { at: '2026-08-13T12:00:00.000Z', ok: false, reason: 'unreachable', message: 'connect ECONNREFUSED', secured: 0, attempted: 1 },
      },
    });
    const { container } = render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /push to vaultwarden/i }));

    await waitFor(() =>
      expect(screen.getByTestId('credentials-push-state').textContent).toMatch(/did not complete/i));
    // The entry must NOT look safe after a failed push.
    expect(screen.getByTestId('credentials-push-state').textContent).toMatch(/ECONNREFUSED/);
    expect(screen.getByTestId('credentials-sync-status').textContent).toMatch(/1 of 1 not yet secured/i);
    expect(container.querySelectorAll('[data-variant="warn"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-variant="ok"]')).toHaveLength(0);
  });

  it('drops the local copy when the hand-off is confirmed', async () => {
    manifestFetch([UNSECURED]);
    const { container } = render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());
    expect(container.textContent).toMatch(/not yet secured/i);

    fireEvent.click(screen.getByRole('button', { name: /drop the local copy/i }));

    await waitFor(() =>
      expect(screen.getByTestId('credentials-sync-status').textContent)
        .toMatch(/All 1 entries are in Vaultwarden/i));
    expect(container.textContent).not.toMatch(/not yet secured/i);
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/system/credentials/secured',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
