/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The forced credential hand-over gate (#2560).
 *
 * Three acceptance criteria live here, and they are the ones most easily
 * faked by an optimistic success path:
 *
 *   1. the window cannot be dismissed until the list has been downloaded,
 *   2. a successful download deletes the local copy in the same operation,
 *   3. a failed or aborted download deletes **nothing** — which means the
 *      confirm call (the only thing that deletes) is never even reached.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CredentialHandoverGate, { notifyCredentialsChanged } from '@/components/CredentialHandoverGate';

const PENDING = {
  service: 'Immich',
  url: 'http://localhost:2283',
  username: 'admin@dopp.cloud',
  // The wire shape since #2605: the state, not the secret.
  secured: false,
  importance: 'critical' as const,
  template: 'immich',
};
const HANDED_OVER = { ...PENDING, service: 'LLDAP', template: 'auth', secured: true };

/** The exact CSV the fake server "sends"; the client must hash what it saved. */
const CSV = 'folder,favorite\n"ServiceBay Home",""\n';

function jsonRes(body: any, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

interface Calls { confirm: any[] }

function installFetch(opts: {
  credentials: any[];
  offer?: any;
  confirmBody?: any;
}): Calls {
  const calls: Calls = { confirm: [] };
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/system/credentials/handover/confirm') {
      calls.confirm.push(JSON.parse(String(init?.body)));
      return jsonRes(opts.confirmBody ?? { ok: true, dropped: opts.credentials.length });
    }
    if (url === '/api/system/credentials/handover') {
      return jsonRes(opts.offer ?? { pending: 1, token: 'tok-1', filename: 'creds.csv', csv: CSV });
    }
    if (url === '/api/system/credentials') {
      return jsonRes({ manifest: { savedAt: 'now', credentials: opts.credentials }, proxyHosts: [] });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as any;
  return calls;
}

/** Stand in for the browser's save step. */
function stubSave(behaviour: 'ok' | 'blocked' | 'aborted') {
  const clicks: string[] = [];
  if (behaviour === 'ok') {
    (window as any).showSaveFilePicker = undefined;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    };
  } else {
    const err = new Error(behaviour === 'aborted' ? 'The user aborted a request.' : 'Downloads are blocked');
    if (behaviour === 'aborted') err.name = 'AbortError';
    (window as any).showSaveFilePicker = vi.fn(async () => { throw err; });
  }
  return clicks;
}

beforeEach(() => {
  (URL as any).createObjectURL = vi.fn(() => 'blob:x');
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).showSaveFilePicker;
});

const seeGate = () => waitFor(() => expect(screen.getByTestId('credential-handover-gate')).toBeTruthy());

describe('CredentialHandoverGate — it cannot be dismissed without a download', () => {
  it('blocks the page whenever ServiceBay still holds a password', async () => {
    installFetch({ credentials: [PENDING, HANDED_OVER] });
    render(<CredentialHandoverGate />);
    await seeGate();

    const gate = screen.getByTestId('credential-handover-gate');
    expect(gate.getAttribute('aria-modal')).toBe('true');
    // Covers the viewport, so nothing underneath is clickable either.
    expect(gate.className).toContain('fixed');
    expect(gate.className).toContain('inset-0');
    // The only control is the download — no close, no cancel, no "later".
    const buttons = Array.from(gate.querySelectorAll('button'));
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent).toMatch(/download/i);
  });

  it('survives Escape and a click on the backdrop', async () => {
    installFetch({ credentials: [PENDING] });
    render(<CredentialHandoverGate />);
    await seeGate();

    fireEvent.keyDown(screen.getByTestId('credential-handover-gate'), { key: 'Escape' });
    fireEvent.click(screen.getByTestId('credential-handover-gate'));
    expect(screen.getByTestId('credential-handover-gate')).toBeTruthy();
  });

  it('states both duties and the consequence of losing the list', async () => {
    installFetch({ credentials: [PENDING] });
    render(<CredentialHandoverGate />);
    await seeGate();

    const text = screen.getByTestId('credential-handover-gate').textContent ?? '';
    expect(text).toMatch(/vaultwarden/i);          // where it goes
    expect(text).toMatch(/share it with nobody/i); // who else may have it
    expect(text).toMatch(/set up again from scratch/i); // what losing it costs
  });

  it('stays out of the way when nothing is pending', async () => {
    installFetch({ credentials: [HANDED_OVER] });
    render(<CredentialHandoverGate />);
    await waitFor(() => expect((global.fetch as any).mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('credential-handover-gate')).toBeNull();
  });

  it('appears as soon as an install announces new credentials', async () => {
    installFetch({ credentials: [] });
    render(<CredentialHandoverGate />);
    await waitFor(() => expect((global.fetch as any).mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId('credential-handover-gate')).toBeNull();

    installFetch({ credentials: [PENDING] });
    act(() => notifyCredentialsChanged());
    await seeGate();
  });
});

describe('CredentialHandoverGate — deletion is gated on proven delivery', () => {
  it('confirms with the receipt of the saved bytes, then closes', async () => {
    const calls = installFetch({ credentials: [PENDING] });
    const clicks = stubSave('ok');
    render(<CredentialHandoverGate />);
    await seeGate();

    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(screen.queryByTestId('credential-handover-gate')).toBeNull());

    expect(clicks).toEqual(['creds.csv']);
    expect(calls.confirm).toHaveLength(1);
    expect(calls.confirm[0].token).toBe('tok-1');
    // The receipt leads with the byte count of exactly what was saved.
    expect(calls.confirm[0].receipt).toMatch(new RegExp(`^${new TextEncoder().encode(CSV).length}-[0-9a-f]{16}$`));
  });

  it('never calls confirm when the browser refuses the download', async () => {
    const calls = installFetch({ credentials: [PENDING] });
    stubSave('blocked');
    render(<CredentialHandoverGate />);
    await seeGate();

    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(screen.getByTestId('credential-handover-error')).toBeTruthy());

    expect(calls.confirm).toEqual([]);
    expect(screen.getByTestId('credential-handover-gate')).toBeTruthy();
    expect(screen.getByTestId('credential-handover-error').textContent).toMatch(/nothing was deleted/i);
  });

  it('never calls confirm when the user cancels the save', async () => {
    const calls = installFetch({ credentials: [PENDING] });
    stubSave('aborted');
    render(<CredentialHandoverGate />);
    await seeGate();

    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(screen.getByTestId('credential-handover-error')).toBeTruthy());

    expect(calls.confirm).toEqual([]);
    expect(screen.getByTestId('credential-handover-gate')).toBeTruthy();
  });

  it('stays up when the server rejects the receipt — nothing was deleted', async () => {
    const calls = installFetch({
      credentials: [PENDING],
      confirmBody: { ok: false, reason: 'receipt_mismatch' },
    });
    stubSave('ok');
    render(<CredentialHandoverGate />);
    await seeGate();

    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(screen.getByTestId('credential-handover-error')).toBeTruthy());

    expect(calls.confirm).toHaveLength(1);
    expect(screen.getByTestId('credential-handover-gate')).toBeTruthy();
  });

  it('never calls confirm when the file could not be fetched at all', async () => {
    const calls = installFetch({ credentials: [PENDING], offer: { error: 'boom' } });
    (global.fetch as any).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/system/credentials/handover') return jsonRes({ error: 'boom' }, 500);
      if (url === '/api/system/credentials/handover/confirm') {
        calls.confirm.push(JSON.parse(String(init?.body)));
        return jsonRes({ ok: true, dropped: 1 });
      }
      return jsonRes({ manifest: { savedAt: 'now', credentials: [PENDING] }, proxyHosts: [] });
    });
    stubSave('ok');
    render(<CredentialHandoverGate />);
    await seeGate();

    fireEvent.click(screen.getByRole('button', { name: /download/i }));
    await waitFor(() => expect(screen.getByTestId('credential-handover-error')).toBeTruthy());
    expect(calls.confirm).toEqual([]);
  });
});
