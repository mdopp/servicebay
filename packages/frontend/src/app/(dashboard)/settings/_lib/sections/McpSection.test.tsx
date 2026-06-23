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

  it('renders on a token Card surface with no raw colour literals', async () => {
    mockFetch(true);
    const { container } = render(<McpSection />);
    await waitFor(() => expect(screen.getByText('MCP Server')).toBeDefined());

    expect(container.querySelector('.bg-surface')).not.toBeNull();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|purple|indigo|amber)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900)/);
  });

  it('toggling mutations still POSTs to /api/settings (behaviour preserved)', async () => {
    mockFetch(true);
    render(<McpSection />);
    await waitFor(() => expect(screen.getByText('MCP Server')).toBeDefined());
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const switches = screen.getAllByRole('switch');
    fireEvent.click(switches[0]);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/settings',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });
});
