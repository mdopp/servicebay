import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import GatewayConfig from './GatewayConfig';
import { ToastProvider } from '@/providers/ToastProvider';

function renderConfig() {
  return render(
    <ToastProvider>
      <GatewayConfig />
    </ToastProvider>,
  );
}

describe('GatewayConfig — design-system tokens (#2100)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ gateway: { type: 'fritzbox', host: 'fritz.box', username: 'admin', password: 'x' } }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads settings then uses token surfaces/borders, no raw gray/amber/blue literals', async () => {
    const { container } = renderConfig();
    await waitFor(() => expect(screen.getByDisplayValue('admin')).toBeTruthy());
    const html = container.innerHTML;
    expect(html).toMatch(/bg-surface/);
    expect(html).toMatch(/border-border/);
    expect(html).not.toMatch(/bg-white|dark:bg-(gray|slate)|border-(gray|slate)-\d|text-(gray|slate)-\d|bg-amber-\d|bg-blue-\d|focus:ring-amber/);
  });

  it('POSTs gateway settings with ssl:true on save (behaviour preserved)', async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL, _opts?: RequestInit) => {
      if (String(u) === '/api/settings' && true) {
        return new Response(JSON.stringify({ gateway: { type: 'fritzbox', host: 'fritz.box', username: '', password: '' } }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderConfig();
    await waitFor(() => expect(screen.getByText('Save')).toBeTruthy());
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string).gateway.ssl).toBe(true);
    });
  });
});
