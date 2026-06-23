/**
 * ServiceRow design-system migration (#2079). Locks the desktop list-row onto
 * the shared primitives (StatusDot/Badge/Button) and the semantic tokens — no
 * raw green-500/blue-600/amber-* literals — while preserving the #2069 image-
 * update action and the status-state mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import ServiceRow, { serviceDotState } from './ServiceRow';

vi.mock('@/components/DomainHealthDot', () => ({
  DomainHealthDot: () => null,
}));

// ServiceActionBar is a shared icon-toolbar, out of scope for this migration
// (#2079) — stub it so the banned-literal assertion measures only ServiceRow's
// own markup.
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

describe('serviceDotState (#2079)', () => {
  it('maps active → ok, inactive → fail, transitional/auto-restart → warn', () => {
    expect(serviceDotState(svc({ active: true, activeState: 'active' })).state).toBe('ok');
    expect(serviceDotState(svc({ active: false, activeState: 'failed' })).state).toBe('fail');
    expect(serviceDotState(svc({ active: false, activeState: 'activating' })).state).toBe('warn');
    expect(serviceDotState(svc({ active: true, subState: 'auto-restart' })).state).toBe('warn');
  });
});

describe('ServiceRow (#2079 primitive migration)', () => {
  it('renders a StatusDot (role=status) instead of an ad-hoc coloured div', () => {
    render(<ServiceRow service={svc()} httpsDomains={new Set()} {...handlers} />);
    // StatusDot carries role="status" + the SR-only state label.
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
  });

  it('renders the #2069 image-update affordance as a clickable Button when onUpdate is given', () => {
    const onUpdate = vi.fn();
    render(
      <ServiceRow service={svc()} httpsDomains={new Set()} imageUpdateAvailable onUpdate={onUpdate} {...handlers} />,
    );
    const btn = screen.getByRole('button', { name: /update now/i });
    btn.click();
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(btn.getAttribute('data-variant')).toBe('secondary');
  });

  it('uses semantic tokens, not raw gray/blue/green colour literals', () => {
    const { container } = render(
      <ServiceRow service={svc({ nodeName: 'edge', labels: { 'servicebay.role': 'system' } })} httpsDomains={new Set()} {...handlers} />,
    );
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(green|red|amber|blue|cyan|orange|emerald|indigo)-\d/);
    expect(html).not.toMatch(/text-gray-\d/);
  });
});
