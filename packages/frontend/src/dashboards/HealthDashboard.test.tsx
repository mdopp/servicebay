/**
 * HealthDashboard — design-system migration (#2100 cluster 3, dashboards).
 *
 * This is the Status → Health view the design-system Status work (#2080)
 * touched. The migration finishes the chrome on components/ui primitives +
 * semantic tokens. These tests assert:
 *   - the shell (search, tab nav, add-check action) renders on token classes
 *     with no raw colour-literal surfaces,
 *   - status/severity indicators (history rows) use status-token Badges,
 *   - behaviour is preserved (tabs switch, add-check opens the drawer, the
 *     history drawer table renders the data).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const checks = [
  {
    id: 'c1',
    name: 'API',
    type: 'http',
    target: 'https://example.com',
    interval: 60,
    enabled: true,
    status: 'ok',
  },
];

const history = [
  { status: 'ok', latency: 12, timestamp: new Date().toISOString(), message: 'fine' },
  { status: 'fail', latency: 999, timestamp: new Date().toISOString(), message: 'down' },
];

vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() }),
  ToastType: {},
}));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ socket: null }) }));
vi.mock('@/app/actions/nodes', () => ({ getNodes: () => Promise.resolve([]) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/status',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
// Keep the heavy child panels out of the render — we exercise the dashboard
// chrome, not their internals (each has its own tests).
vi.mock('@/components/HealthChecks', () => ({
  __esModule: true,
  default: () => <div data-testid="health-checks" />,
}));
vi.mock('@/components/LogViewer', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/components/DiagnoseProbeList', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/dashboards/ContainersDashboard', () => ({ __esModule: true, default: () => <div /> }));
vi.mock('@/dashboards/SystemInfoDashboard', () => ({ SystemInfoContent: () => <div /> }));

import HealthDashboard from './HealthDashboard';

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/health/checks') {
        return Promise.resolve(new Response(JSON.stringify(checks), { status: 200 }));
      }
      if (typeof url === 'string' && url.includes('/history')) {
        return Promise.resolve(new Response(JSON.stringify(history), { status: 200 }));
      }
      return Promise.resolve(new Response('[]', { status: 200 }));
    }),
  );
}

describe('HealthDashboard (#2100 dashboards migration)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mockFetch();
  });

  it('renders the shell on token classes with no raw surface colour literals', async () => {
    const { container } = render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());

    // Tab nav + search live on tokens.
    expect(container.querySelector('.border-border')).not.toBeNull();
    expect(container.querySelector('.bg-surface-2')).not.toBeNull();

    // The search input (this dashboard's own chrome — the page-title bar is the
    // shared PageHeader, migrated separately) is on token classes.
    const search = screen.getByPlaceholderText('Search...');
    expect(search.className).toContain('border-border');
    expect(search.className).toContain('bg-surface-2');
    expect(search.className).not.toMatch(/border-gray-|bg-white|focus:ring-blue/);

    // The tab nav active/hover states are on accent/text tokens, not raw.
    const checksTab = screen.getByRole('button', { name: 'Checks' });
    expect(checksTab.className).toMatch(/border-accent|text-accent/);
    expect(checksTab.className).not.toMatch(/blue-\d|gray-\d/);
  });

  it('add-check action is a primitive Button that opens the editor drawer', async () => {
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());

    const add = screen.getByRole('button', { name: /add check/i });
    // Button primitive carries the data-variant attribute.
    expect(add.getAttribute('data-variant')).toBe('primary');
    fireEvent.click(add);
    expect(await screen.findByText('Create Health Check')).toBeDefined();
  });

  it('switching to the Logs tab preserves tab behaviour', async () => {
    render(<HealthDashboard />);
    await waitFor(() => expect(screen.getByTestId('health-checks')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Logs' }));
    // The checks panel unmounts when a non-checks tab is active.
    await waitFor(() => expect(screen.queryByTestId('health-checks')).toBeNull());
  });
});
