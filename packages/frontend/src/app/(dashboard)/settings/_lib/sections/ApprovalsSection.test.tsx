/**
 * ApprovalsSection — design-system migration (#2100 cluster 2). Asserts the
 * section renders on a token Card surface with Button-primitive approve/reject
 * (no raw colour literals), and that approve/reject still POST to the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ApprovalsSection from './ApprovalsSection';

vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));

const PENDING = {
  id: 'a1',
  service: 'immich',
  title: 'Restart immich',
  description: 'apply config',
  payload: { foo: 'bar' },
  node: 'box',
  created_at: '2026-06-20T10:00:00Z',
  status: 'pending' as const,
};

function mockFetch(approvals: unknown[]) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/approvals') {
      return Promise.resolve(new Response(JSON.stringify({ approvals }), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  }));
}

describe('ApprovalsSection (#2100 settings migration)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('renders on a token Card surface with primitive actions and no raw colour literals', async () => {
    mockFetch([PENDING]);
    const { container } = render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('Restart immich')).toBeDefined());

    expect(container.querySelector('.bg-surface')).not.toBeNull();
    const reject = screen.getByRole('button', { name: /reject/i });
    expect(reject.getAttribute('data-variant')).toBe('danger');
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(blue|amber|emerald|green|red|purple|indigo)-\d/);
    expect(html).not.toMatch(/dark:bg-gray-(800|900|950)/);
  });

  it('Approve still POSTs to the approve endpoint (behaviour preserved)', async () => {
    mockFetch([PENDING]);
    render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('Restart immich')).toBeDefined());
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/approvals/a1/approve', { method: 'POST' }),
    );
  });
});
