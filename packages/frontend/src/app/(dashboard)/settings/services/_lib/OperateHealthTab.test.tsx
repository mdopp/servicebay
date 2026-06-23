/**
 * OperateHealthTab (#2080) — the per-service Operate Health tab. These render
 * tests encode the corrected check→service attribution: a service's own checks
 * are shown, and box-wide diagnose probes are surfaced in a clearly-labelled
 * "Box-wide" section instead of silently vanishing (the "1 ok" symptom).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { Check, ServiceViewModel } from '@servicebay/api-client';
import OperateHealthTab from './OperateHealthTab';

// Fresh Response per call (feedback_vitest_fetch_response_reuse).
function mockChecks(checks: Partial<Check>[]) {
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

const row = (over: Partial<Check>): Partial<Check> => ({
  id: Math.random().toString(36),
  name: 'x',
  type: 'http',
  status: 'ok',
  target: '',
  history: [],
  lastRun: null,
  lastResult: null,
  ...over,
});

afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => { vi.restoreAllMocks(); });

describe('OperateHealthTab (#2080 attribution)', () => {
  it('shows the service own checks AND the box-wide diagnose rows in a labelled section', async () => {
    global.fetch = mockChecks([
      // this service's own check
      row({ name: 'Service: jellyfin', type: 'service', target: 'jellyfin', status: 'ok' }),
      // box-wide diagnose probes — these used to vanish from every service tab
      row({ id: 'diagnose:cert_expiry', name: 'Self-diagnose: TLS certificates', boxWide: true, status: 'ok' }),
      row({ id: 'diagnose:dns_routing', name: 'Self-diagnose: DNS routing', boxWide: true, status: 'fail' }),
      // node singleton check (targets Local) — box-wide too
      row({ name: 'TLS certificate expiry', type: 'cert_expiry', target: 'Local', status: 'ok' }),
      // a DIFFERENT service's check must not appear here
      row({ name: 'Service: immich', type: 'service', target: 'immich', status: 'fail' }),
    ]);

    render(<OperateHealthTab service={svc()} />);

    // service own check present
    await waitFor(() => expect(screen.getByText('Service: jellyfin')).toBeDefined());
    // box-wide section is rendered, clearly labelled, with the diagnose rows
    const boxWide = screen.getByLabelText('Box-wide health checks');
    expect(within(boxWide).getByText('Self-diagnose: TLS certificates')).toBeDefined();
    expect(within(boxWide).getByText('Self-diagnose: DNS routing')).toBeDefined();
    expect(within(boxWide).getByText('TLS certificate expiry')).toBeDefined();
    // the other service's check is not shown on this tab at all
    expect(screen.queryByText('Service: immich')).toBeNull();
  });

  it('shows box-wide diagnostics even when the service has zero own checks (no more "empty" tab)', async () => {
    global.fetch = mockChecks([
      row({ id: 'diagnose:cert_expiry', name: 'Self-diagnose: TLS certificates', boxWide: true, status: 'ok' }),
    ]);
    render(<OperateHealthTab service={svc()} />);

    await waitFor(() => expect(screen.getByText('No service-specific health checks yet.')).toBeDefined());
    const boxWide = screen.getByLabelText('Box-wide health checks');
    expect(within(boxWide).getByText('Self-diagnose: TLS certificates')).toBeDefined();
  });

  // #2078 migration: rows render via design-system primitives (StatusDot per
  // check, no ad-hoc green-500/red-500 icon-box literals).
  it('renders check status via the StatusDot primitive, not raw colour literals', async () => {
    global.fetch = mockChecks([
      row({ name: 'Service: jellyfin', type: 'service', target: 'jellyfin', status: 'ok' }),
      row({ name: 'Service: jellyfin db', type: 'service', target: 'jellyfin', status: 'fail' }),
    ]);
    const { container } = render(<OperateHealthTab service={svc()} />);
    await waitFor(() => expect(screen.getByText('Service: jellyfin')).toBeDefined());
    // StatusDot renders role="status" per row
    expect(container.querySelectorAll('[role="status"]').length).toBeGreaterThanOrEqual(2);
    // old ad-hoc status-icon colour literals are gone
    for (const banned of ['text-green-500', 'text-red-500', 'bg-green-50', 'bg-red-50']) {
      expect(container.innerHTML).not.toContain(banned);
    }
  });
});
