/**
 * AccessRequestsSection — the People & access-request management surface
 * ("User-Page", #2086). Locks the #2073 design-system migration: the section
 * renders on a token Card, each request row carries a StatusDot + Badge chips,
 * the actions are Button primitives (Approve primary / Delete danger), and no
 * raw gray/blue/emerald/amber colour literals leak into the markup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AccessRequestsSection from './AccessRequestsSection';

vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

const PENDING = {
  id: 'r1',
  requestedAt: '2026-06-20T10:00:00Z',
  name: 'Alice Resident',
  email: 'alice@example.com',
  username: 'alice',
  kind: 'resident',
  status: 'pending' as const,
};

function mockFetch(requests: unknown[]) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/system/access-requests') {
      return Promise.resolve(new Response(JSON.stringify({ requests }), { status: 200 }));
    }
    if (url === '/api/auth/lldap-url') {
      return Promise.resolve(new Response(JSON.stringify({ url: 'https://lldap.example' }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }));
}

describe('AccessRequestsSection (#2086 user-page migration)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('renders requests on a token Card with a StatusDot per row and primitive actions', async () => {
    mockFetch([PENDING]);
    const { container } = render(<AccessRequestsSection />);

    await waitFor(() => expect(screen.getByText('Alice Resident')).toBeDefined());

    // Card surface (design-system token), not the old rounded-xl/gray-800 chrome.
    expect(container.querySelector('.bg-surface')).not.toBeNull();
    // A StatusDot announces the request state.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    // Actions are Button primitives: Approve (primary) + Delete (danger).
    expect(screen.getByRole('button', { name: /approve/i })).toBeDefined();
    const del = screen.getByRole('button', { name: /delete request/i });
    expect(del.getAttribute('data-variant')).toBe('danger');
  });

  it('uses no raw colour literals in the migrated markup', async () => {
    mockFetch([PENDING]);
    const { container } = render(<AccessRequestsSection />);
    await waitFor(() => expect(screen.getByText('Alice Resident')).toBeDefined());

    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/text-(blue|emerald|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-800/);
  });

  it('shows the empty state when there are no requests', async () => {
    mockFetch([]);
    render(<AccessRequestsSection />);
    await waitFor(() => expect(screen.getByText(/No access requests yet/)).toBeDefined());
  });
});
