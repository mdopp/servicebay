/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Settings → Saved credentials (#2560).
 *
 * The acceptance criterion this file encodes: the section is not a
 * password table and not a second password manager. No Password column, no
 * reveal, no copy — a hand-over status line plus a Vaultwarden deep link
 * instead, and an explicit "not handed over" marking whenever ServiceBay
 * is still the only copy.
 *
 * It also holds the one entry point outside the install gate, and it must
 * obey the same rule: the local copy goes only against a proven download.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CredentialsSection from '@/app/(dashboard)/settings/_lib/sections/CredentialsSection';

const addToast = vi.fn();
vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast }) }));

const VAULT_HOST = { service: 'vaultwarden', domain: 'vault.dopp.cloud' };

const PENDING = {
  service: 'Immich',
  url: 'http://localhost:2283',
  username: 'admin@dopp.cloud',
  // The wire shape since #2605: the server sends the state, never the secret.
  secured: false,
  importance: 'critical' as const,
  template: 'immich',
};
const HANDED_OVER = {
  service: 'LLDAP',
  url: 'https://ldap.dopp.cloud',
  username: 'admin',
  secured: true,
  importance: 'critical' as const,
  template: 'auth',
};

const CSV = 'folder,favorite\n"ServiceBay Home",""\n';

function jsonRes(body: any, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

/**
 * @param handover  what the two hand-over calls do, and what GET returns
 *                  afterwards. Absent ⇒ the hand-over is never exercised.
 */
function manifestFetch(
  credentials: any[],
  proxyHosts = [VAULT_HOST],
  handover?: { confirmBody: any; after: any[] },
) {
  const state = { credentials };
  const confirmCalls: any[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/system/credentials/handover') {
      return jsonRes({ pending: 1, token: 'tok-1', filename: 'creds.csv', csv: CSV });
    }
    if (url === '/api/system/credentials/handover/confirm') {
      confirmCalls.push(JSON.parse(String(init?.body)));
      if (handover?.confirmBody.ok) state.credentials = handover.after;
      return jsonRes(handover?.confirmBody ?? { ok: true, dropped: 1 });
    }
    if (url === '/api/system/credentials' && init?.method === 'DELETE') return jsonRes({ ok: true });
    if (url === '/api/system/credentials') {
      return jsonRes({
        manifest: { savedAt: '2026-08-12T08:00:00.000Z', credentials: state.credentials },
        proxyHosts,
        publicDomain: 'dopp.cloud',
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as any;
  return { confirmCalls };
}

beforeEach(() => {
  addToast.mockClear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  (URL as any).createObjectURL = vi.fn(() => 'blob:x');
  (URL as any).revokeObjectURL = vi.fn();
  (window as any).showSaveFilePicker = undefined;
  HTMLAnchorElement.prototype.click = function () { /* saved */ };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).showSaveFilePicker;
});

describe('CredentialsSection (#2560)', () => {
  it('renders no password column and never puts a stored secret in the DOM', async () => {
    manifestFetch([PENDING, HANDED_OVER]);
    render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    expect(screen.queryByRole('columnheader', { name: /password/i })).toBeNull();
    // Since #2605 the response carries no password at all — the component
    // could not render one if it wanted to. `credentials_route_redaction`
    // is the test that holds the server to that.
    expect(Object.keys(PENDING)).not.toContain('password');
    expect(screen.queryByTitle(/reveal password/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /^copy$/i })).toBeNull();
    // …replaced by a "where does this live" column.
    expect(screen.getByRole('columnheader', { name: /stored in/i })).toBeTruthy();
  });

  it('marks entries ServiceBay still holds as not handed over', async () => {
    manifestFetch([PENDING, HANDED_OVER]);
    const { container } = render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    expect(screen.getByTestId('credentials-sync-status').textContent)
      .toMatch(/1 of 2 not handed over yet/i);
    const warn = container.querySelectorAll('[data-variant="warn"]');
    const ok = container.querySelectorAll('[data-variant="ok"]');
    expect(warn).toHaveLength(1);
    expect(warn[0].textContent).toMatch(/not handed over/i);
    expect(ok).toHaveLength(1);
    expect(ok[0].textContent).toMatch(/handed over/i);
  });

  it('offers a Vaultwarden deep link and no download once everything is handed over', async () => {
    manifestFetch([HANDED_OVER]);
    render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('LLDAP')).toBeTruthy());

    const status = screen.getByTestId('credentials-sync-status');
    expect(status.textContent).toMatch(/All 1 entries have been handed over/i);
    expect(status.textContent).toMatch(/no longer stores these passwords/i);
    const link = screen.getByRole('link', { name: /open in vaultwarden/i }) as HTMLAnchorElement;
    expect(link.href).toContain('vault.dopp.cloud');
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull();
  });

  it('offers the download when ServiceBay is still the only copy — even with no Vaultwarden', async () => {
    manifestFetch([PENDING], []);
    render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    expect(screen.getByTestId('credentials-sync-status').textContent).toMatch(/not handed over yet/i);
    expect(screen.queryByRole('link', { name: /vaultwarden/i })).toBeNull();
    // The operator is never stuck without a way to get their passwords out.
    expect(screen.getByRole('button', { name: /download the password list/i })).toBeTruthy();
  });

  it('drops the local copy once the download is proven', async () => {
    const { confirmCalls } = manifestFetch([PENDING], [VAULT_HOST], {
      confirmBody: { ok: true, dropped: 1 },
      after: [{ ...PENDING, secured: true }],
    });
    const { container } = render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /download the password list/i }));

    await waitFor(() =>
      expect(screen.getByTestId('credentials-sync-status').textContent)
        .toMatch(/All 1 entries have been handed over/i));
    expect(container.textContent).not.toMatch(/not handed over yet/i);
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0].token).toBe('tok-1');
  });

  it('a rejected receipt leaves the entry pending and says nothing was deleted', async () => {
    manifestFetch([PENDING], [VAULT_HOST], {
      confirmBody: { ok: false, reason: 'receipt_mismatch' },
      after: [PENDING],
    });
    const { container } = render(<CredentialsSection />);
    await waitFor(() => expect(screen.getByText('Immich')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /download the password list/i }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(
      'error',
      expect.stringMatching(/did not complete/i),
      expect.stringMatching(/nothing was deleted/i),
    ));
    // The entry must NOT look safe after a failed hand-over.
    expect(screen.getByTestId('credentials-sync-status').textContent).toMatch(/1 of 1 not handed over yet/i);
    expect(container.querySelectorAll('[data-variant="warn"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-variant="ok"]')).toHaveLength(0);
  });
});
