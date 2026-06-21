/**
 * ServiceDetailSummary (IA slice 1, #2029) — the ONE shared per-service detail
 * rendered on the Operate page header AND the Network-map node sidebar. These
 * render tests pin its observable behaviour (status dot/label, subtitle,
 * Open/Restart/Logs actions, the useServiceHealth-fed roll-up, and the
 * Operate-page link) so the two surfaces never drift apart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Check, ServiceViewModel } from '@servicebay/api-client';
import ServiceDetailSummary from './ServiceDetailSummary';
import { ToastProvider } from '@/providers/ToastProvider';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

// Fresh Response per call — a shared body can only be read once
// (feedback_vitest_fetch_response_reuse).
function mockChecks(checks: Check[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('/api/health/checks')) {
      return new Response(JSON.stringify(checks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function svc(over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return {
    name: 'jellyfin.service',
    displayName: 'Jellyfin',
    yamlBasename: null,
    kubeBasename: null,
    active: true,
    type: 'kube',
    ports: [],
    ...over,
  };
}

function check(over: Partial<Check> & { diagnose?: { status?: string } }): Check {
  return { id: Math.random().toString(36), name: 'x', type: 'http', status: 'ok', target: 'jellyfin', ...over } as Check;
}

function renderSummary(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ServiceDetailSummary', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('renders the service health roll-up from /api/health/checks (worst-status-wins dot + counts)', async () => {
    global.fetch = mockChecks([
      check({ name: 'jellyfin http', status: 'ok' }),
      check({ name: 'jellyfin libraries', status: 'ok' }),
      // a synthetic diagnose row whose four-way status is `warn`
      // (rowStatus reads diagnose.status; the check-level status folds warn into fail).
      check({ name: 'jellyfin cert', status: 'fail', diagnose: { status: 'warn' } }),
      check({ name: 'immich photos', status: 'fail', target: 'immich' }), // not this service
    ]);
    renderSummary(<ServiceDetailSummary service={svc()} />);

    await waitFor(() => expect(screen.getByText('2 ok')).toBeDefined());
    // warn present, but the unrelated immich fail must be filtered out -> no "failing" count, dot is Warning.
    expect(screen.getByText('1 warning')).toBeDefined();
    expect(screen.queryByText(/failing/)).toBeNull();
    expect(screen.getByText('Warning')).toBeDefined();
    expect(screen.getByText('jellyfin cert')).toBeDefined();
  });

  it('shows "Stopped" and an unknown dot for an inactive service regardless of checks', async () => {
    global.fetch = mockChecks([check({ status: 'ok' })]);
    renderSummary(<ServiceDetailSummary service={svc({ active: false })} />);
    expect(await screen.findByText('Stopped')).toBeDefined();
  });

  it('renders an Open link to the primary URL, a subtitle, and the Operate-page link by default', async () => {
    global.fetch = mockChecks([]);
    renderSummary(<ServiceDetailSummary service={svc({ verifiedDomains: ['media.dopp.cloud'], uptime: 7200 })} />);

    await waitFor(() => expect(screen.getByText('No health checks for this service.')).toBeDefined());
    const open = screen.getByText('Open').closest('a')!;
    expect(open.getAttribute('href')).toBe('https://media.dopp.cloud');
    // subtitle = address · uptime
    expect(screen.getByText(/media\.dopp\.cloud · up 2h/)).toBeDefined();
    const operate = screen.getByText('Open full Operate page').closest('a')!;
    expect(operate.getAttribute('href')).toBe('/services/jellyfin.service');
  });

  it('hides the Operate-page link when showOperateLink is false, and hides Open when nothing to open', async () => {
    global.fetch = mockChecks([]);
    renderSummary(<ServiceDetailSummary service={svc()} showOperateLink={false} />);
    await waitFor(() => expect(screen.getByText('No health checks for this service.')).toBeDefined());
    expect(screen.queryByText('Open full Operate page')).toBeNull();
    expect(screen.queryByText('Open')).toBeNull();
  });

  it('Restart POSTs the service action and reports success', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/health/checks')) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/action') && init?.method === 'POST') {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });
    global.fetch = fetchMock;
    renderSummary(<ServiceDetailSummary service={svc()} />);

    fireEvent.click(screen.getByText('Restart').closest('button')!);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) =>
        String(u).includes('/api/services/jellyfin.service/action') && (i as RequestInit)?.method === 'POST',
      )).toBe(true),
    );
  });
});
