/**
 * ServiceTile (#2734) — the merged ServiceCard/ServiceRow. Carries forward both
 * of their #2079 design-system suites: each layout renders on the shared
 * primitives (Card/StatusDot/Badge/Button) + semantic tokens (no raw
 * green-500/blue-600/gray-* literals), keeps the #2069 image-update action, the
 * failed-state restart nudge and the #2108 network-focus jump.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import ServiceTile, { serviceDotState, type ServiceTileLayout } from './ServiceTile';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

vi.mock('@/components/DomainHealthDot', () => ({
  DomainHealthDot: () => null,
}));

// ServiceActionBar is a shared icon-toolbar, out of scope here (#2079) — stub
// it so the banned-literal assertion measures only the tile's own markup.
vi.mock('@/components/ServiceActionBar', () => ({
  ServiceActionBar: () => null,
}));

function svc(over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return {
    id: 'immich.service',
    name: 'immich.service',
    displayName: 'immich',
    type: 'kube',
    active: true,
    activeState: 'active',
    status: 'running',
    verifiedDomains: [],
    ...over,
  } as ServiceViewModel;
}

const noop = () => {};
const handlers = {
  onMonitor: noop, onEdit: noop, onActions: noop,
  onEditLink: noop, onDelete: noop, onRestart: noop,
};

const LAYOUTS: ServiceTileLayout[] = ['card', 'row'];

describe('serviceDotState (#2079)', () => {
  it('maps active → ok, inactive → fail, transitional/auto-restart → warn', () => {
    expect(serviceDotState(svc({ active: true, activeState: 'active' })).state).toBe('ok');
    expect(serviceDotState(svc({ active: false, activeState: 'failed' })).state).toBe('fail');
    expect(serviceDotState(svc({ active: false, activeState: 'activating' })).state).toBe('warn');
    expect(serviceDotState(svc({ active: true, subState: 'auto-restart' })).state).toBe('warn');
  });
});

describe.each(LAYOUTS)('ServiceTile layout=%s (#2734 merge of ServiceCard/ServiceRow)', layout => {
  it('renders a StatusDot (role=status) instead of an ad-hoc coloured div', () => {
    render(<ServiceTile layout={layout} service={svc()} httpsDomains={new Set()} {...handlers} />);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('keeps the #2069 image-update affordance as a clickable Button', () => {
    const onUpdate = vi.fn();
    render(
      <ServiceTile
        layout={layout}
        service={svc()}
        httpsDomains={new Set()}
        imageUpdateAvailable
        onUpdate={onUpdate}
        {...handlers}
      />,
    );
    const btn = screen.getByRole('button', { name: /update now/i });
    btn.click();
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(btn.getAttribute('data-variant')).toBe('secondary');
  });

  it('#2108 renders the network-focus button and navigates to /network?focus=<name>', () => {
    push.mockClear();
    render(<ServiceTile layout={layout} service={svc()} httpsDomains={new Set()} {...handlers} />);
    const btn = screen.getByRole('button', { name: 'Im Netzwerk anzeigen' });
    expect(btn.getAttribute('data-variant')).toBe('ghost');
    btn.click();
    expect(push).toHaveBeenCalledWith('/network?focus=immich.service');
  });

  it('#2108 hides the network-focus button for external-link "services"', () => {
    render(
      <ServiceTile layout={layout} service={svc({ type: 'link', url: 'http://x' })} httpsDomains={new Set()} {...handlers} />,
    );
    expect(screen.queryByRole('button', { name: 'Im Netzwerk anzeigen' })).toBeNull();
  });

  it('surfaces the failed-state restart nudge', () => {
    const onRestart = vi.fn();
    render(
      <ServiceTile
        layout={layout}
        service={svc({ active: false, activeState: 'failed', status: 'failed' })}
        httpsDomains={new Set()}
        {...handlers}
        onRestart={onRestart}
      />,
    );
    screen.getByRole('button', { name: /restart/i }).click();
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('uses semantic tokens, not raw gray/blue/green colour literals', () => {
    const { container } = render(
      <ServiceTile
        layout={layout}
        service={svc({ nodeName: 'edge', labels: { 'servicebay.role': 'system' }, active: false, activeState: 'failed', status: 'failed' })}
        httpsDomains={new Set()}
        {...handlers}
      />,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(green|red|amber|blue|cyan|orange|emerald|indigo)-\d/);
    expect(html).not.toMatch(/text-gray-\d/);
  });
});

describe('ServiceTile layout differences (#2734)', () => {
  it('card renders on the Card surface; row renders as a bare dense list row', () => {
    const { container: card } = render(
      <ServiceTile layout="card" service={svc()} httpsDomains={new Set()} {...handlers} />,
    );
    expect(card.querySelector('.bg-surface')).not.toBeNull();

    const { container: row } = render(
      <ServiceTile layout="row" service={svc()} httpsDomains={new Set()} {...handlers} />,
    );
    expect(row.firstElementChild?.className).toContain('flex items-center');
    expect(row.querySelector('.bg-surface')).toBeNull();
  });

  it('only the card carries the "View logs" half of the failed-state nudge', () => {
    const failed = svc({ active: false, activeState: 'failed', status: 'failed' });
    const { unmount } = render(
      <ServiceTile layout="card" service={failed} httpsDomains={new Set()} {...handlers} />,
    );
    expect(screen.getByRole('button', { name: /view logs/i })).toBeDefined();
    unmount();

    render(<ServiceTile layout="row" service={failed} httpsDomains={new Set()} {...handlers} />);
    expect(screen.queryByRole('button', { name: /view logs/i })).toBeNull();
  });

  it('renders the address for both layouts (verified domains, link URL, gateway IPs)', () => {
    for (const layout of LAYOUTS) {
      const { unmount } = render(
        <ServiceTile
          layout={layout}
          service={svc({ verifiedDomains: ['immich.example.com'] })}
          httpsDomains={new Set(['immich.example.com'])}
          {...handlers}
        />,
      );
      const link = screen.getByRole('link', { name: 'immich.example.com' });
      expect(link.getAttribute('href')).toBe('https://immich.example.com');
      unmount();
    }
  });
});
