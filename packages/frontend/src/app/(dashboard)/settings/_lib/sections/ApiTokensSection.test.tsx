/**
 * ApiTokensSection — design-system migration (#2100 cluster 2). Asserts the
 * section renders on a token Card surface with token rows + Button-primitive
 * revoke (no raw colour literals), and that the create form opens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ApiTokensSection from './ApiTokensSection';

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
  });
});
