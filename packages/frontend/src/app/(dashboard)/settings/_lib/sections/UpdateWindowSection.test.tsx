/**
 * UpdateWindowSection — design-system migration (#2100 cluster 2). Asserts the
 * section renders on a token Card surface (no raw colour literals) and that
 * Save & apply still PUTs the update-window config.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import UpdateWindowSection from './UpdateWindowSection';

vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

function mockFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
    if (url === '/api/system/update-window' && (!opts || opts.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify({ window: { enabled: true, days: ['Sat'], startTime: '03:00', lengthMinutes: 120, applyTo: { os: true, containers: true, servicebay: false } } }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }));
}

describe('UpdateWindowSection (#2100 settings migration)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('renders its controls with no inner duplicate title and no raw colour literals (#2109)', async () => {
    mockFetch();
    const { container } = render(<UpdateWindowSection />);
    await waitFor(() => expect(screen.getByRole('button', { name: /save & apply/i })).toBeDefined());

    // No "Auto-update window" h3 inside the section — the SettingDisclosure
    // header carries the icon+title+description now (#2109).
    expect(container.querySelector('h3')).toBeNull();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|rose|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|rose|purple|indigo|amber)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  it('Save & apply still PUTs the window (behaviour preserved)', async () => {
    mockFetch();
    render(<UpdateWindowSection />);
    await waitFor(() => expect(screen.getByRole('button', { name: /save & apply/i })).toBeDefined());
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fireEvent.click(screen.getByRole('button', { name: /save & apply/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/system/update-window',
        expect.objectContaining({ method: 'PUT' }),
      ),
    );
  });
});
