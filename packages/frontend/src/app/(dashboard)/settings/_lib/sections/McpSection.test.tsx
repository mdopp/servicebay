/**
 * McpSection — design-system migration (#2100 cluster 2). Asserts the section
 * renders on a token Card surface (no raw colour literals) and that the
 * mutations safety toggle still POSTs to /api/settings.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import McpSection from './McpSection';

vi.mock('../clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));
vi.mock('@/components/SectionHelp', () => ({ default: () => <button>How to connect</button> }));

function mockFetch(allowMutations: boolean) {
  vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
    if (url === '/api/settings' && (!opts || opts.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify({ mcp: { allowMutations, allowDangerousExec: false } }), { status: 200 }));
    }
    if (url.startsWith('/api/system/mcp/approve')) {
      return Promise.resolve(new Response(JSON.stringify({ pending: [] }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }));
}

describe('McpSection (#2100 settings migration)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('renders its controls with no inner duplicate title and no raw colour literals (#2109)', async () => {
    mockFetch(true);
    const { container } = render(<McpSection />);
    await waitFor(() => expect(screen.getByText('MCP endpoint')).toBeDefined());

    // No "MCP Server" h2/h3 title inside the section — the SettingDisclosure
    // header carries the icon+title+description now (#2109).
    expect(container.querySelector('h2, h3')).toBeNull();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|purple|indigo|amber)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  // ADR 0007 amendment 2026-08-17. A client running on the box cannot use the
  // browser's origin — that is nginx-proxy-manager on :443, routing by vhost,
  // and this admin host is LAN-only with `deny all`. The card therefore shows a
  // second, app-port URL. This pins the distinction the whole amendment exists
  // for: the two fields must NOT be the same value, and the on-box one must
  // carry the host alias and an explicit port.
  it('shows a separate on-box endpoint on the app port, distinct from the browser origin', async () => {
    mockFetch(true);
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText('MCP endpoint')).toBeDefined());
    expect(screen.getByText('From a container on this box')).toBeDefined();

    const browserUrl = (screen.getByDisplayValue(/^https?:\/\/localhost/) as HTMLInputElement).value;
    const onBox = screen.getByDisplayValue(/host\.containers\.internal/) as HTMLInputElement;

    expect(onBox.value).toBe('http://host.containers.internal:5888/mcp');
    expect(onBox.value).not.toBe(browserUrl);
    // Plain HTTP is deliberate here (host-local link-local traffic), so a future
    // "https everywhere" sweep does not silently break this path.
    expect(onBox.value.startsWith('http://')).toBe(true);
  });

  it('copies the on-box endpoint, not the browser one', async () => {
    mockFetch(true);
    const { copyToClipboard } = await import('../clipboard');
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText('From a container on this box')).toBeDefined());

    fireEvent.click(screen.getByTitle('Copy on-box URL'));
    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith('http://host.containers.internal:5888/mcp'),
    );
  });

  it('toggling mutations still POSTs to /api/settings (behaviour preserved)', async () => {
    mockFetch(true);
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText('MCP endpoint')).toBeDefined());
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // Wait for the initial GET /api/settings to resolve so the toggle reflects
    // loaded state — clicking before that races the async load and the POST
    // never fires within the window (CI parallel-load flake).
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/settings'),
    );
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  }, 15000);
});
