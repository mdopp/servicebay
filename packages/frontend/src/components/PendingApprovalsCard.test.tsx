import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

import PendingApprovalsCard from './PendingApprovalsCard';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const APPROVAL = {
  pendingId: 'abc-123',
  toolName: 'remove_proxy_route',
  args: { domain: 'tor.dopp.cloud' },
  caller: 'token:Repair',
  expiresAt: Date.parse('2026-07-11T12:00:00Z'),
};

describe('PendingApprovalsCard (#2203-followup)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('renders nothing when there are no pending approvals', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ pending: [] })));
    const { container } = render(<PendingApprovalsCard />);
    // Flush the on-mount fetch promise, then assert the card stays absent.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/Pending approvals/i)).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('shows a proposed destructive tool call with its args and caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ pending: [APPROVAL] })));
    render(<PendingApprovalsCard />);
    expect(await screen.findByText(/Pending approvals/i)).toBeTruthy();
    expect(screen.getByText('remove_proxy_route')).toBeTruthy();
    expect(screen.getByText(/tor\.dopp\.cloud/)).toBeTruthy();
    expect(screen.getByText(/from token:Repair/)).toBeTruthy();
  });

  it('approves via POST to the pendingId endpoint', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.includes('/approve/') && opts?.method === 'POST') return jsonResponse({ ok: true });
      // after approval the list is reloaded empty
      return jsonResponse({ pending: fetchMock.mock.calls.some(c => String(c[0]).includes('/approve/')) ? [] : [APPROVAL] });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PendingApprovalsCard />);
    const btn = await screen.findByText(/Approve & run/i);
    await act(async () => { btn.click(); });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/system/mcp/approve/abc-123', { method: 'POST' }),
    );
  });

  it('rejects via DELETE to the pendingId endpoint (#2234)', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.includes('/approve/') && opts?.method === 'DELETE') return jsonResponse({ ok: true });
      return jsonResponse({ pending: fetchMock.mock.calls.some(c => (c[1] as RequestInit)?.method === 'DELETE') ? [] : [APPROVAL] });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PendingApprovalsCard />);
    const btn = await screen.findByText(/^Reject$/i);
    await act(async () => { btn.click(); });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/system/mcp/approve/abc-123', { method: 'DELETE' }),
    );
  });

  // #2691. "Nothing to approve" and "the check failed" used to render
  // identically — as nothing at all — so an expired session cookie looked
  // exactly like an all-clear while a destructive request sat unapproved.
  // These pin both sides of the fix: the failure must become visible, and it
  // must not become visible so eagerly that operators learn to ignore it.
  describe('a failed poll is not an empty queue (#2691)', () => {
    const POLL_MS = 15_000;

    it('absorbs a single blip, then says the check failed rather than reading as empty', async () => {
      const fetchMock = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
      vi.stubGlobal('fetch', fetchMock);
      const { container } = render(<PendingApprovalsCard />);

      // One transient miss stays quiet — a banner on every blip is a banner
      // nobody reads.
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await act(async () => { await Promise.resolve(); });
      expect(container.textContent).toBe('');

      // The second consecutive failure speaks up.
      await act(async () => { vi.advanceTimersByTime(POLL_MS); });
      expect(await screen.findByText(/Couldn't check for pending approvals/i)).toBeTruthy();
      // The negative that matters: the card must NOT be indistinguishable from
      // a confirmed-empty queue (which renders as the empty string above).
      expect(container.textContent).not.toBe('');
      expect(container.textContent).toMatch(/not the same as an empty queue/i);
    });

    it('keeps a known-pending request visible when a later poll fails', async () => {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls += 1;
        return calls === 1 ? jsonResponse({ pending: [APPROVAL] }) : jsonResponse({ error: 'boom' }, 500);
      });
      vi.stubGlobal('fetch', fetchMock);
      render(<PendingApprovalsCard />);
      expect(await screen.findByText('remove_proxy_route')).toBeTruthy();

      await act(async () => { vi.advanceTimersByTime(POLL_MS); });
      await act(async () => { vi.advanceTimersByTime(POLL_MS); });

      expect(await screen.findByText(/may be out of date/i)).toBeTruthy();
      // A failed poll must never overwrite a known-pending list with an empty one.
      expect(screen.getByText('remove_proxy_route')).toBeTruthy();
    });

    it('treats a thrown/network failure the same as a non-2xx one', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      const { container } = render(<PendingApprovalsCard />);
      await act(async () => { vi.advanceTimersByTime(POLL_MS); });
      expect(await screen.findByText(/Failed to fetch/)).toBeTruthy();
      expect(container.textContent).not.toBe('');
    });

    it('stays silent for a genuinely empty queue even after many polls', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ pending: [] })));
      const { container } = render(<PendingApprovalsCard />);
      await act(async () => { vi.advanceTimersByTime(POLL_MS); });
      await act(async () => { vi.advanceTimersByTime(POLL_MS); });
      expect(container.textContent).toBe('');
    });

    it('clears the warning once the poll recovers', async () => {
      let calls = 0;
      const fetchMock = vi.fn(async () => {
        calls += 1;
        return calls <= 2 ? jsonResponse({ error: 'boom' }, 503) : jsonResponse({ pending: [] });
      });
      vi.stubGlobal('fetch', fetchMock);
      const { container } = render(<PendingApprovalsCard />);
      await act(async () => { vi.advanceTimersByTime(POLL_MS); });
      expect(await screen.findByText(/Couldn't check for pending approvals/i)).toBeTruthy();

      await act(async () => { vi.advanceTimersByTime(POLL_MS); });
      await waitFor(() => expect(container.textContent).toBe(''));
    });
  });

  it('renders a durable approval (expiresAt null) as "awaiting approval", not Invalid Date (#2234)', async () => {
    const durable = { ...APPROVAL, expiresAt: null };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ pending: [durable] })));
    render(<PendingApprovalsCard />);
    expect(await screen.findByText(/awaiting approval/i)).toBeTruthy();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });
});
