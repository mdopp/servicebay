/**
 * ReverseProxySection — design-system migration (#2100 cluster 2). Asserts the
 * section renders on a token Card surface with a status Badge (no raw colour
 * literals) and that Re-key still POSTs to the NPM credentials endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ReverseProxySection from './ReverseProxySection';

vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

function mockFetch(status: string) {
  vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
    if (url === '/api/system/nginx/credentials' && (!opts || opts.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify({ configured: true, email: 'admin@box', status }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ message: 'ok' }), { status: 200 }));
  }));
}

describe('ReverseProxySection (#2100 settings migration)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('renders its controls with the status Badge and no inner duplicate title (#2109)', async () => {
    mockFetch('ok');
    const { container } = render(<ReverseProxySection />);
    await waitFor(() => expect(screen.getByText('Verified')).toBeDefined());

    // No "Reverse Proxy (NPM)" h3 inside the section — the SettingDisclosure
    // header carries the icon+title+description now (#2109).
    expect(container.querySelector('h3')).toBeNull();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|purple|indigo|amber)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  it('Re-key still POSTs to the credentials endpoint (behaviour preserved)', async () => {
    mockFetch('rejected');
    render(<ReverseProxySection />);
    await waitFor(() => expect(screen.getByText('Out of sync')).toBeDefined());
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fireEvent.click(screen.getByRole('button', { name: /re-key/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/system/nginx/credentials',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
