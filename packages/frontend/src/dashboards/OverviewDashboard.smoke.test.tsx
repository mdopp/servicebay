/**
 * Home OverviewDashboard render smoke test (#2067).
 *
 * The diagnose-helper unit tests (OverviewDashboard.diagnose.test.ts) cover the
 * pure summarize/cardView functions; this mounts the actual dashboard so the
 * render path — health headline + the now-CLICKABLE StatCards (operator
 * feedback: the Home cards used to be inert) — is exercised. We assert the
 * headline renders and the cards are real navigation links (href to
 * /services and /status), which is the whole point of the fix.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import OverviewDashboard from './OverviewDashboard';
import { ToastProvider } from '@/providers/ToastProvider';

// Next <Link> renders a plain <a> in jsdom; no router needed for href checks.
vi.mock('@/providers/DigitalTwinProvider', () => ({
  useDigitalTwinContext: () => ({
    data: {
      serverName: 'test-box',
      gateway: { upstreamStatus: 'up' },
      nodes: {
        Local: {
          services: [
            { name: 'a.service', activeState: 'active' },
            { name: 'b.service', activeState: 'active' },
          ],
        },
      },
    },
    isConnected: true,
  }),
}));

vi.mock('@/hooks/useCoreHealth', () => ({
  useCoreHealth: () => ({ unhealthy: false }),
}));

describe('OverviewDashboard render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // /api/health/checks read — return zero diagnose rows (neutral card).
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [],
    })) as unknown as typeof fetch);
  });

  it('renders the health headline and links the cards to /services and /status', () => {
    render(
      <ToastProvider>
        <OverviewDashboard />
      </ToastProvider>,
    );

    // Healthy box (2/2 active, gateway up, core healthy) → the good headline.
    expect(screen.getByText('Everything looks healthy')).toBeDefined();

    // The Home cards are now clickable navigation, not inert blocks.
    const servicesCard = screen.getByText('Services').closest('a');
    expect(servicesCard).not.toBeNull();
    expect(servicesCard?.getAttribute('href')).toBe('/services');

    const diagnosticsCard = screen.getByText('Diagnostics').closest('a');
    expect(diagnosticsCard).not.toBeNull();
    expect(diagnosticsCard?.getAttribute('href')).toBe('/status');
  });

  it('renders the image-updates banner on Home when the report has pending updates (#1860)', async () => {
    // image-updates report returns one pending service; everything else neutral.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/system/stacks/image-updates')) {
        return {
          ok: true,
          json: async () => ({
            services: [
              { service: 'a', image: 'ghcr.io/a:latest', runningDigest: 'sha256:old', registryDigest: 'sha256:new', updateAvailable: true },
            ],
          }),
        };
      }
      return { ok: true, json: async () => [] };
    }) as unknown as typeof fetch);

    render(
      <ToastProvider>
        <OverviewDashboard />
      </ToastProvider>,
    );

    expect(await screen.findByText(/1 service image update available/i)).toBeDefined();
    expect(await screen.findByRole('button', { name: /update now/i })).toBeDefined();
  });
});
