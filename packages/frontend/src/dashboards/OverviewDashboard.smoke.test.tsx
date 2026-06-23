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

// A well-formed self-update status: on the latest version, auto-update off.
const UP_TO_DATE_STATUS = {
  hasUpdate: false,
  current: '4.140.0',
  latest: null,
  config: { autoUpdate: { enabled: false, schedule: '' } },
};

/** Route-aware fetch: the consolidated Updates section (#2082) mounts the
 *  ServiceBay updater card (GET /api/system/update) alongside the image-updates
 *  banner, so the mock must answer the updater endpoint with a valid status. */
function routedFetch(extra: (url: string) => unknown | undefined) {
  return vi.fn(async (url: string) => {
    const u = typeof url === 'string' ? url : '';
    const override = extra(u);
    if (override !== undefined) return override;
    if (u.includes('/api/system/update')) {
      return { ok: true, json: async () => UP_TO_DATE_STATUS };
    }
    return { ok: true, json: async () => [] };
  }) as unknown as typeof fetch;
}

describe('OverviewDashboard render', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: /api/health/checks → zero diagnose rows; /api/system/update →
    // up-to-date; everything else → [].
    vi.stubGlobal('fetch', routedFetch(() => undefined));
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

  it('renders Home StatCards on the token Card surface, not raw gray literals (#2079)', () => {
    render(
      <ToastProvider>
        <OverviewDashboard />
      </ToastProvider>,
    );
    // The clickable StatCards render a <Card> (bg-surface) inside the <Link>.
    // Scope the literal check to the cards themselves (the embedded updater /
    // image banners are separate, out-of-scope components).
    const servicesCardLink = screen.getByText('Services').closest('a');
    expect(servicesCardLink).not.toBeNull();
    const card = servicesCardLink!.querySelector('.bg-surface');
    expect(card).not.toBeNull();
    const cardHtml = (card as HTMLElement).outerHTML;
    expect(cardHtml).not.toMatch(/bg-(white|gray-900|gray-50)/);
    expect(cardHtml).not.toMatch(/text-gray-\d/);
    expect(cardHtml).not.toMatch(/(border|text)-(emerald|amber|red|blue)-\d/);
  });

  it('renders the image-updates banner on Home when the report has pending updates (#1860)', async () => {
    // image-updates report returns one pending service; everything else neutral.
    vi.stubGlobal('fetch', routedFetch(url => {
      if (url.includes('/api/system/stacks/image-updates')) {
        return {
          ok: true,
          json: async () => ({
            services: [
              { service: 'a', image: 'ghcr.io/a:latest', runningDigest: 'sha256:old', registryDigest: 'sha256:new', updateAvailable: true },
            ],
          }),
        };
      }
      return undefined;
    }));

    render(
      <ToastProvider>
        <OverviewDashboard />
      </ToastProvider>,
    );

    expect(await screen.findByText(/1 service image update available/i)).toBeDefined();
    expect(await screen.findByRole('button', { name: /update now/i })).toBeDefined();
  });

  it('consolidates the SB self-updater and service image-updates under one Updates section (#2082)', async () => {
    // SB updater reports an available version (its own "Update Now" trigger),
    // AND an image update is pending (the banner's trigger) — both must sit in
    // the single Updates area, each with its button.
    vi.stubGlobal('fetch', routedFetch(url => {
      if (url.includes('/api/system/update')) {
        return {
          ok: true,
          json: async () => ({
            hasUpdate: true,
            current: '4.140.0',
            latest: { version: '4.141.0', url: '', date: '', notes: '' },
            config: { autoUpdate: { enabled: false, schedule: '' } },
          }),
        };
      }
      if (url.includes('/api/system/stacks/image-updates')) {
        return {
          ok: true,
          json: async () => ({
            services: [
              { service: 'a', image: 'ghcr.io/a:latest', runningDigest: 'sha256:old', registryDigest: 'sha256:new', updateAvailable: true },
            ],
          }),
        };
      }
      return undefined;
    }));

    render(
      <ToastProvider>
        <OverviewDashboard />
      </ToastProvider>,
    );

    // One Updates section heading.
    expect(await screen.findByRole('heading', { name: /^Updates$/ })).toBeDefined();
    // The SB self-updater half: its status + its own Update Now trigger.
    expect(await screen.findByText(/ServiceBay Updates/)).toBeDefined();
    expect(await screen.findByText(/New version available: 4\.141\.0/)).toBeDefined();
    // The per-service image-updates half: its roll-up + its own trigger.
    expect(await screen.findByText(/1 service image update available/i)).toBeDefined();
    // Two distinct "Update Now/now" triggers (SB updater + image banner).
    const triggers = await screen.findAllByRole('button', { name: /update now/i });
    expect(triggers.length).toBe(2);
  });
});
