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

// Fields every row the real /api/health/checks route sends, whether it's a
// stored check (created_at/interval/enabled from CheckConfig — see
// packages/frontend/src/app/api/health/checks/route.ts's `enrichedChecks`
// map, which spreads the stored check as-is) or a synthetic `diagnose:*` row
// (stamped explicitly in packages/backend/src/lib/diagnose/diagnoseChecks.ts
// `getDiagnoseChecksEnriched`). `HealthCheckRowSchema` requires them, so a
// mock missing them fails validation and `useServiceHealth` correctly (if
// silently) settles to an empty state — matching this file's own defaults
// with the real route keeps the mock from drifting off the wire contract.
const row = (over: Partial<Check>): Partial<Check> => ({
  id: Math.random().toString(36),
  name: 'x',
  type: 'http',
  status: 'ok',
  target: '',
  interval: 60,
  enabled: true,
  created_at: new Date(0).toISOString(),
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

  // #2394 — a `domain:` check for the service's OWN verified domain used to be
  // hard-classified box-wide. It now arrives with the backend-stamped
  // `serviceName` and must render in the service's own list, while genuinely
  // platform-level rows (DNS/TLS infra, storage) stay in the box-wide section.
  it('shows the service own domain check on its Health tab, not the box-wide list', async () => {
    global.fetch = mockChecks([
      row({ id: 'domain:media.dopp.cloud', name: 'Domain — media.dopp.cloud', type: 'domain', target: 'media.dopp.cloud', serviceName: 'media', status: 'ok' }),
      // another stack's domain — attributed elsewhere, so it appears nowhere here
      row({ id: 'domain:paperless.dopp.cloud', name: 'Domain — paperless.dopp.cloud', type: 'domain', target: 'paperless.dopp.cloud', serviceName: 'paperless', status: 'ok' }),
      // an orphan route nothing claims stays box-wide (visible, not hidden)
      row({ id: 'domain:stale.dopp.cloud', name: 'Domain — stale.dopp.cloud', type: 'domain', target: 'stale.dopp.cloud', status: 'fail' }),
      // this stack's crash_loop diagnose row, attributed by its items
      row({ id: 'diagnose:crash_loop', name: 'Self-diagnose: Containers stable', boxWide: false, serviceName: 'media', status: 'fail' }),
      // genuinely platform-level — stays box-wide
      row({ id: 'diagnose:dns_routing', name: 'Self-diagnose: DNS routing', boxWide: true, status: 'ok' }),
      row({ id: 'diagnose:disk', name: 'Self-diagnose: Storage (/mnt/data)', boxWide: true, status: 'ok' }),
    ]);

    render(<OperateHealthTab service={svc({ name: 'media.service', displayName: 'Media', verifiedDomains: ['media.dopp.cloud'] })} />);

    await waitFor(() => expect(screen.getByText('Domain — media.dopp.cloud')).toBeDefined());
    const boxWide = screen.getByLabelText('Box-wide health checks');
    // the service's own domain + crash_loop rows are NOT in the box-wide section
    expect(within(boxWide).queryByText('Domain — media.dopp.cloud')).toBeNull();
    expect(within(boxWide).queryByText('Self-diagnose: Containers stable')).toBeNull();
    expect(screen.getByText('Self-diagnose: Containers stable')).toBeDefined();
    // only true platform-level checks remain box-wide (plus the orphan route)
    expect(within(boxWide).getByText('Self-diagnose: DNS routing')).toBeDefined();
    expect(within(boxWide).getByText('Self-diagnose: Storage (/mnt/data)')).toBeDefined();
    expect(within(boxWide).getByText('Domain — stale.dopp.cloud')).toBeDefined();
    // another stack's domain check never shows on this tab
    expect(screen.queryByText('Domain — paperless.dopp.cloud')).toBeNull();
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
