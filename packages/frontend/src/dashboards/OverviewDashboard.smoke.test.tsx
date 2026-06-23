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
import OverviewDashboard, { systemStatusView, lastUpdatedView } from './OverviewDashboard';
import { ToastProvider } from '@/providers/ToastProvider';

// Mutable so individual tests can inject a `resources` slice for the System
// tile (#2096) without re-mocking the whole module.
let twinNode: Record<string, unknown> = {
  services: [
    { name: 'a.service', activeState: 'active' },
    { name: 'b.service', activeState: 'active' },
  ],
};

// Next <Link> renders a plain <a> in jsdom; no router needed for href checks.
vi.mock('@/providers/DigitalTwinProvider', () => ({
  useDigitalTwinContext: () => ({
    data: {
      serverName: 'test-box',
      gateway: { upstreamStatus: 'up' },
      nodes: {
        Local: twinNode,
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
    // Reset the twin node to the default (no resources slice) before each test.
    twinNode = {
      services: [
        { name: 'a.service', activeState: 'active' },
        { name: 'b.service', activeState: 'active' },
      ],
    };
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

  it('renders the Updates section image banner on the token Card surface, not the old ad-hoc blue literals (#2093)', async () => {
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

    // The migrated banner sits on a <Card> (bg-surface) with a token accent —
    // no raw blue literals (border-blue-200 / bg-blue-50 / bg-blue-600) anymore.
    const bannerText = await screen.findByText(/1 service image update available/i);
    const card = bannerText.closest('.bg-surface');
    expect(card).not.toBeNull();
    const html = (card as HTMLElement).outerHTML;
    expect(html).not.toMatch(/(border|bg|text)-blue-\d/);
    // Token accent present for the "update available" state.
    expect(html).toMatch(/accent/);
  });

  it('renders the System-status tile linking to Status→System (#2096) with split disk + Last updated (#2104)', () => {
    // Inject a resources slice on the twin so the tile shows real metrics,
    // including per-mount disks[] for the System/Data split (#2104).
    twinNode = {
      ...twinNode,
      resources: {
        cpuUsage: 12,
        memoryUsage: 4 * 1024 * 1024 * 1024,
        totalMemory: 16 * 1024 * 1024 * 1024,
        diskUsage: 47,
        disks: [
          { mountpoint: '/', total: 100, used: 30 }, // System 30%
          { mountpoint: '/var/mnt/data', total: 100, used: 78 }, // Data 78%
        ],
        os: { uptime: 90000 },
      },
    };

    render(
      <ToastProvider>
        <OverviewDashboard />
      </ToastProvider>,
    );

    // The tile renders and is a clickable link to the Status→System view.
    // (Disambiguate: "System" is now both the tile <h2> AND a disk <dt> row.)
    const systemLink = screen.getByText('System', { selector: 'h2' }).closest('a');
    expect(systemLink).not.toBeNull();
    expect(systemLink?.getAttribute('href')).toBe('/status?tab=system');
    // CPU / RAM rows present; Disk is split into System + Data; Uptime is gone,
    // replaced by Last updated (#2104).
    expect(screen.getByText('CPU')).toBeDefined();
    expect(screen.getByText('RAM')).toBeDefined();
    expect(screen.getByText('System', { selector: 'dt' })).toBeDefined();
    expect(screen.getByText('Data')).toBeDefined();
    expect(screen.getByText('30%')).toBeDefined();
    expect(screen.getByText('78%')).toBeDefined();
    expect(screen.getByText('Last updated')).toBeDefined();
    expect(screen.queryByText('Uptime')).toBeNull();
    expect(screen.getByText('12%')).toBeDefined();
  });

  it('gives every Home tile an icon + title on one header row (#2103)', () => {
    twinNode = {
      ...twinNode,
      resources: {
        cpuUsage: 12,
        memoryUsage: 4 * 1024 * 1024 * 1024,
        totalMemory: 16 * 1024 * 1024 * 1024,
        disks: [{ mountpoint: '/', total: 100, used: 30 }],
        os: { uptime: 3600 },
      },
    };
    render(
      <ToastProvider>
        <OverviewDashboard />
      </ToastProvider>,
    );
    // Every tile's <h2> title sits in a flex row that also carries an <svg>
    // icon as a sibling — icon + title inline, no tile missing its icon.
    for (const title of ['Services', 'Diagnostics']) {
      const heading = screen.getByText(title, { selector: 'h2' });
      const header = heading.parentElement!;
      expect(header.className).toContain('flex');
      expect(header.querySelector('svg')).not.toBeNull();
    }
    // System tile header (its <h2> is "System", dt label is different).
    const sysHeading = screen.getByText('System', { selector: 'h2' });
    expect(sysHeading.parentElement!.className).toContain('flex');
    expect(sysHeading.parentElement!.querySelector('svg')).not.toBeNull();
  });

  it('orders the Diagnostics tile last on mobile, natural order on desktop (#2105)', () => {
    render(
      <ToastProvider>
        <OverviewDashboard />
      </ToastProvider>,
    );
    // The Diagnostics tile link carries the responsive order utilities:
    // order-last on mobile, reset to source order at ≥sm.
    const diagnosticsLink = screen.getByText('Diagnostics', { selector: 'h2' }).closest('a');
    expect(diagnosticsLink).not.toBeNull();
    expect(diagnosticsLink!.className).toContain('order-last');
    expect(diagnosticsLink!.className).toContain('sm:order-none');
  });

  it('renders the System tile in a neutral waiting state when no agent report is present', () => {
    // Default twinNode has no `resources` slice.
    render(
      <ToastProvider>
        <OverviewDashboard />
      </ToastProvider>,
    );
    const systemLink = screen.getByText('System').closest('a');
    expect(systemLink).not.toBeNull();
    expect(systemLink?.getAttribute('href')).toBe('/status?tab=system');
    expect(screen.getByText(/Waiting for system report/i)).toBeDefined();
  });
});

describe('systemStatusView (#2096)', () => {
  it('returns a neutral unloaded view when resources are absent', () => {
    expect(systemStatusView(undefined)).toEqual({ loaded: false, tone: 'neutral', rows: [] });
    expect(systemStatusView(null)).toEqual({ loaded: false, tone: 'neutral', rows: [] });
    // No os slice yet (agent hasn't reported) → still unloaded.
    expect(systemStatusView({ cpuUsage: 10 })).toEqual({ loaded: false, tone: 'neutral', rows: [] });
  });

  it('splits Disk into System + Data and ends with Last updated (#2104)', () => {
    const view = systemStatusView(
      {
        cpuUsage: 10,
        memoryUsage: 2 * 1024 * 1024 * 1024,
        totalMemory: 16 * 1024 * 1024 * 1024,
        disks: [
          { mountpoint: '/', total: 100, used: 30 },
          { mountpoint: '/var/mnt/data', total: 100, used: 50 },
        ],
        os: { uptime: 3600 },
      },
      new Date().toISOString(),
    );
    expect(view.loaded).toBe(true);
    expect(view.tone).toBe('good');
    expect(view.rows.map(r => r.label)).toEqual(['CPU', 'RAM', 'System', 'Data', 'Last updated']);
    expect(view.rows.find(r => r.label === 'System')?.value).toBe('30%');
    expect(view.rows.find(r => r.label === 'Data')?.value).toBe('50%');
    expect(view.rows.find(r => r.label === 'Last updated')?.value).toBe('Just now');
  });

  it('accepts /mnt/data (non-FCoS mount path) for the Data partition (#2104)', () => {
    const view = systemStatusView({
      disks: [
        { mountpoint: '/', total: 100, used: 20 },
        { mountpoint: '/mnt/data', total: 100, used: 60 },
      ],
      os: { uptime: 60 },
    });
    expect(view.rows.find(r => r.label === 'Data')?.value).toBe('60%');
  });

  it('falls back to the single Disk figure when no per-mount breakdown exists (#2104)', () => {
    const view = systemStatusView({
      diskUsage: 47,
      os: { uptime: 60 },
    });
    // No disks[] → surface the one figure, do NOT fake a split.
    const labels = view.rows.map(r => r.label);
    expect(labels).toContain('Disk');
    expect(labels).not.toContain('System');
    expect(labels).not.toContain('Data');
    expect(view.rows.find(r => r.label === 'Disk')?.value).toBe('47%');
  });

  it('escalates the tone to the worst metric (bad wins over warn/good)', () => {
    const view = systemStatusView({
      cpuUsage: 85, // warn
      memoryUsage: 15.5 * 1024 * 1024 * 1024,
      totalMemory: 16 * 1024 * 1024 * 1024, // ~97% → bad
      disks: [{ mountpoint: '/', total: 100, used: 10 }], // good
      os: { uptime: 120 },
    });
    expect(view.tone).toBe('bad');
  });

  it('Last updated tone does not escalate the worst-of system tone (#2104)', () => {
    // A stale box (Last updated = warn) with all-good metrics stays good — a
    // freshness warning is not a resource-pressure problem.
    const old = new Date(Date.now() - 120 * 86400000).toISOString();
    const view = systemStatusView(
      {
        cpuUsage: 10,
        disks: [{ mountpoint: '/', total: 100, used: 10 }],
        os: { uptime: 60 },
      },
      old,
    );
    expect(view.rows.find(r => r.label === 'Last updated')?.tone).toBe('warn');
    expect(view.tone).toBe('good');
  });

  it('degrades gracefully to neutral rows when a metric is missing', () => {
    const view = systemStatusView({ os: { uptime: 60 } });
    expect(view.loaded).toBe(true);
    // No usage figures → no escalation, neutral overall.
    expect(view.tone).toBe('neutral');
    expect(view.rows.find(r => r.label === 'CPU')?.value).toBe('—');
  });
});

describe('lastUpdatedView (#2104)', () => {
  const now = Date.parse('2026-06-23T12:00:00Z');

  it('is neutral "Never" when there is no applied-update timestamp', () => {
    expect(lastUpdatedView(undefined, now)).toEqual({ value: 'Never', tone: 'neutral' });
    expect(lastUpdatedView(null, now)).toEqual({ value: 'Never', tone: 'neutral' });
    expect(lastUpdatedView('not-a-date', now)).toEqual({ value: 'Never', tone: 'neutral' });
  });

  it('reports a recent update as good with a relative age', () => {
    expect(lastUpdatedView('2026-06-23T11:30:00Z', now)).toEqual({ value: 'Just now', tone: 'good' });
    expect(lastUpdatedView('2026-06-23T09:00:00Z', now)).toEqual({ value: '3h ago', tone: 'good' });
    expect(lastUpdatedView('2026-06-20T12:00:00Z', now)).toEqual({ value: '3d ago', tone: 'good' });
  });

  it('warns once the last update is older than the freshness threshold', () => {
    const old = new Date(now - 90 * 86400000).toISOString();
    expect(lastUpdatedView(old, now)).toEqual({ value: '90d ago', tone: 'warn' });
  });
});
