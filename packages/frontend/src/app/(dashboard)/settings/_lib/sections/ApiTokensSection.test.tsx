/**
 * ApiTokensSection — design-system migration (#2100 cluster 2). Asserts the
 * section renders on a token Card surface with token rows + Button-primitive
 * revoke (no raw colour literals), and that the create form opens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ApiTokensSection from './ApiTokensSection';
import { ALL_SCOPES } from '@/lib/auth/apiScope';

vi.mock('../clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));

const TOKEN = {
  id: 't1', name: 'workstation', scopes: ['read', 'destroy'], prefix: 'ab12',
  createdAt: '2026-06-20T10:00:00Z', createdBy: 'admin',
};

function mockFetch(tokens: unknown[]) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/system/mcp-bootstrap') {
      return Promise.resolve(new Response(JSON.stringify({ active: false }), { status: 200 }));
    }
    if (url === '/api/system/api-tokens') {
      return Promise.resolve(new Response(JSON.stringify({ tokens }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }));
}

describe('ApiTokensSection (#2100 settings migration)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('renders its controls with a Button-primitive revoke and no inner duplicate title (#2109)', async () => {
    mockFetch([TOKEN]);
    const { container } = render(<ApiTokensSection />);
    await waitFor(() => expect(screen.getByText('workstation')).toBeDefined());

    // The section no longer renders its own titled Card+header — that lives in
    // the SettingDisclosure now (#2109). No "API tokens" h2/h3 title here.
    expect(container.querySelector('h2, h3')).toBeNull();
    const revoke = screen.getByRole('button', { name: /revoke workstation/i });
    expect(revoke.getAttribute('data-variant')).toBe('danger');
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|emerald|green|purple|orange)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  it('opens the create form on New token (behaviour preserved)', async () => {
    mockFetch([]);
    render(<ApiTokensSection />);
    await waitFor(() => expect(screen.getByText(/No tokens yet/)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /new token/i }));
    expect(screen.getByRole('button', { name: /^create$/i })).toBeDefined();
  });

  // #2299: the "Never Expires" checkbox is offered only for a read-only scope
  // set; selecting any broader scope disables it (fail-closed, mirroring the
  // server's 403 guard).
  it('Never Expires checkbox is enabled for read-only scopes and disabled once a broader scope is selected', async () => {
    mockFetch([]);
    render(<ApiTokensSection />);
    await waitFor(() => expect(screen.getByText(/No tokens yet/)).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /new token/i }));

    const neverExpires = screen.getByRole('checkbox', { name: /never expires/i }) as HTMLInputElement;
    // Default scope set is ['read'] → enabled.
    expect(neverExpires.disabled).toBe(false);

    // Selecting `mutate` (a non-read scope) disables it.
    fireEvent.click(screen.getByRole('checkbox', { name: /^mutate$/i }));
    expect(neverExpires.disabled).toBe(true);
    // …and it can't stay checked.
    expect(neverExpires.checked).toBe(false);

    // Removing `mutate` again re-enables it.
    fireEvent.click(screen.getByRole('checkbox', { name: /^mutate$/i }));
    expect(neverExpires.disabled).toBe(false);
  });

  it('shows "Expires: Never" for a token with no expiresAt', async () => {
    mockFetch([{ ...TOKEN, scopes: ['read'], expiresAt: undefined }]);
    render(<ApiTokensSection />);
    await waitFor(() => expect(screen.getByText('workstation')).toBeDefined());
    expect(screen.getByText(/Expires: Never/i)).toBeDefined();
  });

  // #2164: revoke is guarded by the typed-confirmation ConfirmModal, not a bare
  // browser confirm() — consistent with stack-wipe / service-delete / factory-reset.
  it('revoke opens a typed-confirmation modal that blocks until the token name is typed', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/system/mcp-bootstrap') {
        return Promise.resolve(new Response(JSON.stringify({ active: false }), { status: 200 }));
      }
      if (url.startsWith('/api/system/api-tokens')) {
        if (init?.method === 'DELETE') return Promise.resolve(new Response('{}', { status: 200 }));
        return Promise.resolve(new Response(JSON.stringify({ tokens: [TOKEN] }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    // A bare browser confirm() must never be used on this path.
    const confirmSpy = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmSpy);

    render(<ApiTokensSection />);
    await waitFor(() => expect(screen.getByText('workstation')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /revoke workstation/i }));

    // Modal is open with the typed-confirmation prompt referencing the token name.
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeDefined();
    expect(screen.getByText(/Type/i)).toBeDefined();

    // No bare confirm() was fired.
    expect(confirmSpy).not.toHaveBeenCalled();

    // Confirm is disabled until the exact token name is typed.
    const confirmBtn = screen.getByRole('button', { name: /revoke token/i }) as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);

    const input = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'wrong-name' } });
    expect(confirmBtn.disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'workstation' } });
    expect(confirmBtn.disabled).toBe(false);

    fireEvent.click(confirmBtn);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/system/api-tokens?id=t1', { method: 'DELETE' }),
    );
    // A successful revoke closes the dialog.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  // #2461: `setRevokeTarget(null)` used to run in `finally`, so a failed DELETE
  // closed the modal with no error — the operator believed a still-live token
  // had been locked out.
  it('keeps the confirm modal open and shows an error when the revoke call fails', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/system/mcp-bootstrap') {
        return Promise.resolve(new Response(JSON.stringify({ active: false }), { status: 200 }));
      }
      if (url.startsWith('/api/system/api-tokens')) {
        if (init?.method === 'DELETE') {
          return Promise.resolve(new Response(JSON.stringify({ error: 'token store is read-only' }), { status: 500 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ tokens: [TOKEN] }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApiTokensSection />);
    await waitFor(() => expect(screen.getByText('workstation')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /revoke workstation/i }));

    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'workstation' } });
    fireEvent.click(screen.getByRole('button', { name: /revoke token/i }));

    // The server's reason is surfaced, in the dialog, which stays open.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/token store is read-only/);
    expect(alert.textContent).toMatch(/still active/i);
    expect(screen.getByRole('dialog')).toBeDefined();
    // The token is still listed — nothing was optimistically removed.
    expect(screen.getByRole('button', { name: /revoke workstation/i })).toBeDefined();
    // Not stuck mid-flight either: the retry path is live again.
    await waitFor(() => expect(screen.getByRole('button', { name: /^revoke token$/i })).toBeDefined());
  });

  // ── #2606 / #2608: hygiene readout + multi-select bulk revoke ──────────────
  describe('bulk revoke (#2608) and hygiene counts (#2606)', () => {
    const FLEET = [
      { id: 'aaaaaaaa', name: 'dormant-destroy', scopes: ['read', 'destroy'], prefix: 'ab12', createdAt: '2026-06-01T10:00:00Z', createdBy: 'admin' },
      { id: 'bbbbbbbb', name: 'used-read', scopes: ['read'], prefix: 'cd34', createdAt: '2026-06-02T10:00:00Z', createdBy: 'admin', lastUsedAt: '2026-08-20T10:00:00Z' },
      { id: 'cccccccc', name: 'this-session', scopes: ['read'], prefix: 'ef56', createdAt: '2026-06-03T10:00:00Z', createdBy: 'admin', lastUsedAt: '2026-08-24T10:00:00Z' },
    ];
    const SUMMARY = { total: 3, expiredInGrace: 0, neverExpires: 3, neverUsed: 1, dormant: 1, privileged: 1, graceDays: 3 };

    /** GET returns the fleet + summary + the session's own token id; POST
     *  /revoke returns whatever the test dictates. */
    function mockFleet(revokeResponse: () => Promise<Response>, currentTokenId: string | null = 'cccccccc') {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/system/mcp-bootstrap') {
          return Promise.resolve(new Response(JSON.stringify({ active: false }), { status: 200 }));
        }
        if (url === '/api/system/api-tokens/revoke') return revokeResponse();
        if (url.startsWith('/api/system/api-tokens')) {
          if (init?.method === 'DELETE') return Promise.resolve(new Response('{}', { status: 200 }));
          return Promise.resolve(new Response(JSON.stringify({ tokens: FLEET, summary: SUMMARY, currentTokenId }), { status: 200 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    const openBulkModal = async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: /select all tokens/i }));
      fireEvent.click(screen.getByRole('button', { name: /revoke selected \(2\)/i }));
      return screen.findByRole('dialog');
    };

    it('shows the counted never-expiring / never-used states instead of deleting them (#2606)', async () => {
      mockFleet(() => Promise.resolve(new Response('{}', { status: 200 })));
      render(<ApiTokensSection />);
      const status = await screen.findByRole('status');
      expect(status.textContent).toMatch(/3 tokens/);
      expect(status.textContent).toMatch(/3 never expire/);
      expect(status.textContent).toMatch(/1 never used/);
      expect(status.textContent).toMatch(/1 carry destroy/);
      // Nothing was deleted to produce that readout.
      expect(screen.getByText('dormant-destroy')).toBeDefined();
    });

    it('excludes the session’s own token from select-all and locks its checkbox (#2608)', async () => {
      mockFleet(() => Promise.resolve(new Response('{}', { status: 200 })));
      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText('this-session')).toBeDefined());

      const own = screen.getByRole('checkbox', { name: /this-session \(this session/i }) as HTMLInputElement;
      expect(own.disabled).toBe(true);

      // "All" counts only the two selectable rows.
      expect(screen.getByText(/^All \(2\)$/)).toBeDefined();
      fireEvent.click(screen.getByRole('checkbox', { name: /select all tokens/i }));
      expect(screen.getByRole('button', { name: /revoke selected \(2\)/i })).toBeDefined();
      expect(own.checked).toBe(false);
    });

    it('one typed confirmation lists each token’s name, scopes and last use — not just a count', async () => {
      mockFleet(() => Promise.resolve(new Response(JSON.stringify({ requested: 2, revoked: 2, results: [] }), { status: 200 })));
      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText('used-read')).toBeDefined());
      const dialog = await openBulkModal();

      expect(dialog.textContent).toMatch(/dormant-destroy/);
      expect(dialog.textContent).toMatch(/\[read,destroy\]/);
      expect(dialog.textContent).toMatch(/never used/);
      expect(dialog.textContent).toMatch(/last used/);
    });

    it('the typed phrase spells out the destroy count, so extra friction lands on the dangerous selection', async () => {
      mockFleet(() => Promise.resolve(new Response(JSON.stringify({ requested: 2, revoked: 2, results: [{ id: 'aaaaaaaa', ok: true }, { id: 'bbbbbbbb', ok: true }] }), { status: 200 })));
      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText('used-read')).toBeDefined());
      const dialog = await openBulkModal();

      const confirmBtn = screen.getByRole('button', { name: /^revoke 2$/i }) as HTMLButtonElement;
      expect(confirmBtn.disabled).toBe(true);
      const input = dialog.querySelector('input[type="text"]') as HTMLInputElement;

      // The short phrase is NOT enough — the selection carries `destroy`.
      fireEvent.change(input, { target: { value: 'revoke 2' } });
      expect(confirmBtn.disabled).toBe(true);
      fireEvent.change(input, { target: { value: 'revoke 2 including 1 destroy' } });
      expect(confirmBtn.disabled).toBe(false);

      fireEvent.click(confirmBtn);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('reports a PARTIAL bulk run per token and keeps the dialog open (#2461 at bulk scale)', async () => {
      mockFleet(() => Promise.resolve(new Response(JSON.stringify({
        requested: 2,
        revoked: 1,
        results: [
          { id: 'aaaaaaaa', name: 'dormant-destroy', ok: true },
          // No `name`: the server can only name a token it found, and a row
          // that failed *because it was already gone* comes back nameless. The
          // report must still say "used-read", not the 8-hex id the operator
          // never saw.
          { id: 'bbbbbbbb', ok: false, error: 'token store is read-only' },
        ],
      }), { status: 207 })));
      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText('used-read')).toBeDefined());
      const dialog = await openBulkModal();
      fireEvent.change(dialog.querySelector('input[type="text"]') as HTMLInputElement, {
        target: { value: 'revoke 2 including 1 destroy' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^revoke 2$/i }));

      const alert = await screen.findByRole('alert');
      // The denominator, not a bare "revoked".
      expect(alert.textContent).toMatch(/1 of 2 revoked/);
      expect(alert.textContent).toMatch(/still active/);
      // …and the token that failed is named (from the selection, since the
      // server couldn't name it), with the reason — never a bare id.
      expect(alert.textContent).toMatch(/used-read/);
      expect(alert.textContent).not.toMatch(/bbbbbbbb/);
      expect(alert.textContent).toMatch(/token store is read-only/);
      // The dialog stays open — a failed revoke must never look like a success.
      expect(screen.getByRole('dialog')).toBeDefined();
    });

    it('surfaces a network failure on a bulk run without closing the dialog or claiming success', async () => {
      mockFleet(() => Promise.reject(new Error('network down')));
      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText('used-read')).toBeDefined());
      const dialog = await openBulkModal();
      fireEvent.change(dialog.querySelector('input[type="text"]') as HTMLInputElement, {
        target: { value: 'revoke 2 including 1 destroy' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^revoke 2$/i }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/network down/);
      expect(alert.textContent).toMatch(/nothing was revoked/i);
      expect(screen.getByRole('dialog')).toBeDefined();
    });

    it('a selection filter picks the never-used tokens in one click', async () => {
      mockFleet(() => Promise.resolve(new Response('{}', { status: 200 })));
      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText('used-read')).toBeDefined());
      fireEvent.click(screen.getByRole('button', { name: /^never used$/i }));
      expect(screen.getByRole('button', { name: /revoke selected \(1\)/i })).toBeDefined();
    });

    it('marks an expired token as expired-pending-removal rather than hiding it (#2606)', async () => {
      const expiredFleet = [{ ...FLEET[1], expiresAt: '2026-08-24T10:00:00Z' }];
      vi.stubGlobal('fetch', vi.fn((url: string) => {
        if (url === '/api/system/mcp-bootstrap') return Promise.resolve(new Response(JSON.stringify({ active: false }), { status: 200 }));
        if (url.startsWith('/api/system/api-tokens')) {
          return Promise.resolve(new Response(JSON.stringify({
            tokens: expiredFleet,
            summary: { ...SUMMARY, total: 1, expiredInGrace: 1, neverExpires: 0, neverUsed: 0, dormant: 0, privileged: 0 },
            currentTokenId: null,
          }), { status: 200 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }));
      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText('used-read')).toBeDefined());
      expect(screen.getByText(/removed after the grace period/i)).toBeDefined();
      expect((await screen.findByRole('status')).textContent).toMatch(/1 expired \(auto-removed after 3 days\)/);
    });
  });

  // ── #2609: the scope vocabulary exists ONCE ────────────────────────────────
  // The defect this block guards is drift, not one missing checkbox. The create
  // form used to carry its own shortened copy of ALL_SCOPES, and the frontend
  // ApiScope type was a second copy — so `propose` was never offered, no token
  // on the box could reach `propose_learning`, and the whole learning Rückkanal
  // (#2326) sat behind a checkbox that had never existed. Nothing could go red:
  // SCOPE_BADGE was a Record over the *local* type, so widening the backend
  // vocabulary type-checked cleanly. These assertions read the backend's
  // ALL_SCOPES and compare it against what the UI actually renders, so the next
  // scope added to apiScope.ts fails here instead of silently disappearing.
  describe('scope vocabulary is derived from apiScope.ts, never restated (#2609)', () => {
    const openCreateForm = async () => {
      mockFetch([]);
      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText(/No tokens yet/)).toBeDefined());
      fireEvent.click(screen.getByRole('button', { name: /new token/i }));
    };

    /** The scope checkboxes in the create form, by their rendered label. */
    const renderedScopeNames = () =>
      screen
        .getAllByRole('checkbox')
        .map(cb => cb.getAttribute('aria-label') ?? cb.closest('label')?.textContent?.trim() ?? '')
        .filter(name => (ALL_SCOPES as string[]).includes(name));

    it('offers a checkbox for EVERY backend scope — no more, no less', async () => {
      await openCreateForm();
      // Exact set equality in both directions: a scope dropped from the UI
      // fails, and a scope the UI invents that the server would reject fails too.
      expect([...renderedScopeNames()].sort()).toEqual([...ALL_SCOPES].sort());
      // Named explicitly so the regression that motivated this can't come back
      // silently if the derivation above is ever loosened.
      expect(ALL_SCOPES).toContain('propose');
      expect(screen.getByRole('checkbox', { name: /^propose$/i })).toBeDefined();
    });

    it('renders a distinct badge for every scope — no missing SCOPE_BADGE key', async () => {
      // A scope absent from SCOPE_BADGE renders `className="… undefined"`: no
      // crash, no type error, just an unstyled chip nobody notices in review.
      const everyScope = { ...TOKEN, scopes: [...ALL_SCOPES] };
      mockFetch([everyScope]);
      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText('workstation')).toBeDefined());
      for (const scope of ALL_SCOPES) {
        const badge = screen.getByText(scope, { selector: 'span' });
        expect(badge.className, `no SCOPE_BADGE entry for "${scope}"`).not.toMatch(/undefined/);
        expect(badge.className.trim().length).toBeGreaterThan(0);
      }
    });

    it('explains every scope in the help text', async () => {
      await openCreateForm();
      const help = screen.getByText(/read = list\/get only/);
      for (const scope of ALL_SCOPES) {
        expect(help.textContent, `help text does not mention "${scope}"`).toMatch(
          new RegExp(`\\b${scope}\\b`),
        );
      }
    });

    // `propose` is deliberately OFF the read<…<exec blast-radius ladder
    // (apiScope.ts): nothing implies it and it implies nothing. So it has to be
    // selectable entirely on its own — a propose-only token that can submit
    // knowledge and do nothing else is the whole point of the separate scope.
    it('mints a propose-ONLY token — the scope neither needs nor grants any other', async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === '/api/system/mcp-bootstrap') {
          return Promise.resolve(new Response(JSON.stringify({ active: false }), { status: 200 }));
        }
        if (url.startsWith('/api/system/api-tokens')) {
          if (init?.method === 'POST') {
            return Promise.resolve(new Response(JSON.stringify({ secret: 'sb_test' }), { status: 200 }));
          }
          return Promise.resolve(new Response(JSON.stringify({ tokens: [] }), { status: 200 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      });
      vi.stubGlobal('fetch', fetchMock);

      render(<ApiTokensSection />);
      await waitFor(() => expect(screen.getByText(/No tokens yet/)).toBeDefined());
      fireEvent.click(screen.getByRole('button', { name: /new token/i }));

      fireEvent.change(screen.getByPlaceholderText(/Claude Code on workstation/i), {
        target: { value: 'learning-channel' },
      });
      fireEvent.click(screen.getByRole('checkbox', { name: /^propose$/i }));
      // Drop the default `read` so the request carries `propose` and nothing else.
      fireEvent.click(screen.getByRole('checkbox', { name: /^read$/i }));
      fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

      await waitFor(() => {
        const post = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'POST');
        expect(post, 'no POST was issued — propose alone must be a valid scope set').toBeDefined();
        expect(JSON.parse(String((post![1] as RequestInit).body)).scopes).toEqual(['propose']);
      });
    });
  });

  it('surfaces a network failure on revoke without closing the modal', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/system/mcp-bootstrap') {
        return Promise.resolve(new Response(JSON.stringify({ active: false }), { status: 200 }));
      }
      if (url.startsWith('/api/system/api-tokens')) {
        if (init?.method === 'DELETE') return Promise.reject(new Error('network down'));
        return Promise.resolve(new Response(JSON.stringify({ tokens: [TOKEN] }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ApiTokensSection />);
    await waitFor(() => expect(screen.getByText('workstation')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: /revoke workstation/i }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(dialog.querySelector('input[type="text"]') as HTMLInputElement, {
      target: { value: 'workstation' },
    });
    fireEvent.click(screen.getByRole('button', { name: /revoke token/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/network down/);
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});
