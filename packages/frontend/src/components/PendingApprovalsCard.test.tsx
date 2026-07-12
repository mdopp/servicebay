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

  it('renders a durable approval (expiresAt null) as "awaiting approval", not Invalid Date (#2234)', async () => {
    const durable = { ...APPROVAL, expiresAt: null };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ pending: [durable] })));
    render(<PendingApprovalsCard />);
    expect(await screen.findByText(/awaiting approval/i)).toBeTruthy();
    expect(screen.queryByText(/Invalid Date/)).toBeNull();
  });
});
