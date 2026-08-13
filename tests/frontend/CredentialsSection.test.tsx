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

function manifestFetch(credentials: any[], proxyHosts = [VAULT_HOST]) {
  installFetch([
    {
      pattern: /\/api\/system\/credentials\/secured$/,
      responder: () => jsonRes({ ok: true, secured: 1, securedAt: '2026-08-13T12:00:00.000Z' }),
    },
    {
      pattern: /\/api\/system\/credentials$/,
      responder: () => jsonRes({
        manifest: { savedAt: '2026-08-12T08:00:00.000Z', credentials },
        proxyHosts,
        publicDomain: 'dopp.cloud',
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
    manifestFetch([UNSECURED], []);
    render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    const status = screen.getByTestId('credentials-sync-status');
    expect(status.textContent).toMatch(/not yet secured/i);
    expect(status.textContent).toMatch(/Vaultwarden isn't installed/i);
    expect(screen.queryByRole('link', { name: /vaultwarden/i })).toBeNull();
    // The CSV escape hatch stays, so the operator is not stuck.
    expect(screen.getByRole('button', { name: /download csv/i })).toBeTruthy();
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
