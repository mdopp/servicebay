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

  it('the details toggle is a Button primitive that expands the payload on click', async () => {
    mockFetch([PENDING]);
    render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('Restart immich')).toBeDefined());

    const toggle = screen.getByTitle('Show details');
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('data-variant')).toBe('ghost');
    expect((toggle as HTMLButtonElement).disabled).toBe(false);

    expect(screen.queryByText(/"foo": "bar"/)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(/"foo": "bar"/)).toBeDefined();
    expect(screen.getByTitle('Collapse details')).toBe(toggle);
  });

  it('disables the details toggle when the request has no payload', async () => {
    mockFetch([{ ...PENDING, payload: {} }]);
    render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('Restart immich')).toBeDefined());

    const toggle = screen.getByTitle('No additional details');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * An agent-filed install request (#2965, criterion 2): the operator has to see
 * exactly what would be installed AT THE MOMENT OF APPROVAL. An approval of an
 * opaque operation is not an approval, so the plan is rendered outright —
 * never only behind the payload disclosure the reviewer has to think to open.
 */
const INSTALL_REQUEST = {
  id: 'a2',
  service: 'linkwarden',
  title: 'install linkwarden as linkwarden',
  description: 'An agent (token:pi-dev) asks ServiceBay to install this template. Nothing has been installed.',
  payload: {
    kind: 'install-request',
    caller: 'token:pi-dev',
    installRequestId: 'req-7f3a',
    plan: {
      template: 'linkwarden',
      templateSource: 'Local',
      serviceName: 'linkwarden',
      subdomain: 'links',
      mounts: [{ host: '/mnt/data/stacks/linkwarden/data', container: '/data', mode: 'rw' }],
      ports: [{ host: 8099, container: 3000 }],
      variables: { TZ: 'Europe/Berlin' },
    },
  },
  node: 'box',
  created_at: '2026-09-09T10:00:00Z',
  status: 'pending' as const,
};

describe('an install request shows what would be installed (#2965)', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('names template, service name, subdomain, mounts and ports without expanding anything', async () => {
    mockFetch([INSTALL_REQUEST]);
    render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('install linkwarden as linkwarden')).toBeDefined());

    // No click, no disclosure — these are on screen next to the Approve button.
    expect(screen.getByText('Template')).toBeDefined();
    expect(screen.getByText('linkwarden (from Local)')).toBeDefined();
    expect(screen.getByText('Service name')).toBeDefined();
    expect(screen.getByText('Subdomain')).toBeDefined();
    expect(screen.getByText('links')).toBeDefined();
    expect(screen.getByText('Mounts')).toBeDefined();
    expect(screen.getByText('/mnt/data/stacks/linkwarden/data → /data (rw)')).toBeDefined();
    expect(screen.getByText('Ports')).toBeDefined();
    expect(screen.getByText('8099→3000/tcp')).toBeDefined();
    expect(screen.getByText('TZ=Europe/Berlin')).toBeDefined();
  });

  it('says "none" rather than silently omitting a reach the request did not ask for', async () => {
    const bare = {
      ...INSTALL_REQUEST,
      payload: {
        ...INSTALL_REQUEST.payload,
        plan: { template: 'uptime-kuma', serviceName: 'uptime', subdomain: null, mounts: [], ports: [], variables: {} },
      },
    };
    mockFetch([bare]);
    render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('Template')).toBeDefined());
    expect(screen.getAllByText('none')).toHaveLength(4); // subdomain, mounts, ports, variables
  });

  it('leaves a plain approval alone — no install summary where there is no plan', async () => {
    mockFetch([PENDING]);
    render(<ApprovalsSection />);
    await waitFor(() => expect(screen.getByText('Restart immich')).toBeDefined());
    expect(screen.queryByText('Template')).toBeNull();
  });
});
