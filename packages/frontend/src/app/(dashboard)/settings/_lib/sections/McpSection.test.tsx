/**
 * McpSection — design-system migration (#2100 cluster 2). Asserts the section
 * renders on a token Card surface (no raw colour literals) and that the
 * mutations safety toggle still POSTs to /api/settings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
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

/**
 * Settings fetch + an approvals poll that fails with `status`. Everything else
 * answers normally, so only the approvals surface is under test.
 */
function mockFetchWithBrokenApprovals(status = 401) {
  const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
    if (url === '/api/settings' && (!opts || opts.method === undefined)) {
      return Promise.resolve(new Response(JSON.stringify({ mcp: { allowMutations: true, allowDangerousExec: false } }), { status: 200 }));
    }
    if (url.startsWith('/api/system/mcp/approve')) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'nope' }), { status }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const APPROVAL = {
  pendingId: 'abc-123',
  toolName: 'remove_proxy_route',
  args: { domain: 'example.test' },
  caller: 'token:Repair',
  expiresAt: null,
};

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

  // #2691. The Settings approvals list rendered nothing both when the queue was
  // empty and when the poll failed, so a broken check read as "all clear".
  describe('a failed approvals poll is not an empty queue (#2691)', () => {
    const POLL_MS = 15_000;
    afterEach(() => vi.useRealTimers());

    it('reports the broken check on a repeat failure instead of rendering as empty', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      mockFetchWithBrokenApprovals(401);
      render(<McpSection />);
      await waitFor(() => expect(screen.getByText('MCP endpoint')).toBeDefined());

      // A single miss is absorbed — no banner on every 15s blip.
      expect(screen.queryByText(/Couldn't check for pending approvals/i)).toBeNull();
      expect(screen.queryByText(/Pending destructive approvals/i)).toBeNull();

      await act(async () => { vi.advanceTimersByTime(POLL_MS); });

      expect(await screen.findByText(/Couldn't check for pending approvals/i)).toBeTruthy();
      // The negative: the approvals area must no longer be absent, which is
      // exactly how a confirmed-empty queue renders.
      expect(screen.getByText(/Pending destructive approvals/i)).toBeTruthy();
      expect(screen.getByText(/not the same as an empty queue/i)).toBeTruthy();
    });

    it('reports a failed manual Refresh on the first click, and keeps the known entry', async () => {
      let approveCalls = 0;
      vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
        if (url === '/api/settings' && (!opts || opts.method === undefined)) {
          return Promise.resolve(new Response(JSON.stringify({ mcp: { allowMutations: true, allowDangerousExec: false } }), { status: 200 }));
        }
        if (url.startsWith('/api/system/mcp/approve')) {
          approveCalls += 1;
          return approveCalls === 1
            ? Promise.resolve(new Response(JSON.stringify({ pending: [APPROVAL] }), { status: 200 }))
            : Promise.resolve(new Response(JSON.stringify({ error: 'nope' }), { status: 500 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      }));

      render(<McpSection />);
      expect(await screen.findByText('remove_proxy_route')).toBeTruthy();

      // An explicit user action gets no grace period — a Refresh that silently
      // does nothing is the same "reported success, did nothing" defect.
      fireEvent.click(screen.getByText(/Refresh/i));

      expect(await screen.findByText(/may be out of date/i)).toBeTruthy();
      // …and the request we already know about must survive the failed refresh.
      expect(screen.getByText('remove_proxy_route')).toBeTruthy();
    });

    it('stays silent for a genuinely empty queue', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      mockFetch(true);
      render(<McpSection />);
      await waitFor(() => expect(screen.getByText('MCP endpoint')).toBeDefined());
      await act(async () => { vi.advanceTimersByTime(POLL_MS); });
      await act(async () => { vi.advanceTimersByTime(POLL_MS); });
      expect(screen.queryByText(/Pending destructive approvals/i)).toBeNull();
      expect(screen.queryByText(/Couldn't check for pending approvals/i)).toBeNull();
    });
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
