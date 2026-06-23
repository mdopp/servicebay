/**
 * PortalAccessSection — design-system migration (#2100 cluster 2). Asserts the
 * section renders on a token Card surface (no raw colour literals) and that
 * saving max-users still PUTs to the portal-settings endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import PortalAccessSection from './PortalAccessSection';

vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/system/portal-settings') {
      return Promise.resolve(new Response(JSON.stringify({ maxUsers: 20, portalLanOnly: false }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }));
}

describe('PortalAccessSection (#2100 settings migration)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('renders its controls with no inner duplicate title and no raw colour literals (#2109)', async () => {
    mockFetch();
    const { container } = render(<PortalAccessSection />);
    await waitFor(() => expect(screen.getByText('Maximum users')).toBeDefined());

    // No "Portal access" h3 inside the section — the SettingDisclosure header
    // carries the icon+title+description now (#2109).
    expect(container.querySelector('h3')).toBeNull();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  it('Save still PUTs the portal settings (behaviour preserved)', async () => {
    mockFetch();
    render(<PortalAccessSection />);
    await waitFor(() => expect(screen.getByText('Maximum users')).toBeDefined());
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/system/portal-settings',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
  });
});
