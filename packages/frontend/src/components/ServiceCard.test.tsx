/**
 * ServiceCard design-system migration (#2079). Locks the mobile card onto the
 * shared primitives (Card/StatusDot/Badge/Button) and semantic tokens, keeping
 * the #2069 image-update action and the failed-state restart/logs nudge.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import ServiceCard, { type ServiceCardProps } from './ServiceCard';

vi.mock('@/components/DomainHealthDot', () => ({
  DomainHealthDot: () => null,
}));

// ServiceActionBar is a shared icon-toolbar, out of scope for this migration
// (#2079) — stub it so the banned-literal assertion measures only ServiceCard's
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
const handlers: Omit<ServiceCardProps, 'service' | 'httpsDomains'> = {
  attachNodeContext: c => c,
  onMonitor: noop, onEdit: noop, onActions: noop, onEditLink: noop,
  onDelete: noop, onRestart: noop,
  onContainerLogs: noop, onContainerTerminal: noop, onContainerActions: noop,
};

describe('ServiceCard (#2079 primitive migration)', () => {
  it('renders the card on a token surface with a StatusDot', () => {
    const { container } = render(<ServiceCard service={svc()} httpsDomains={new Set()} {...handlers} />);
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    expect(container.querySelector('.bg-surface')).not.toBeNull();
  });

  it('keeps the #2069 image-update action as a clickable Button', () => {
    const onUpdate = vi.fn();
    render(
      <ServiceCard service={svc()} httpsDomains={new Set()} imageUpdateAvailable onUpdate={onUpdate} {...handlers} />,
    );
    screen.getByRole('button', { name: /update now/i }).click();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it('surfaces the failed-state restart nudge (and uses no raw colour literals)', () => {
    const onRestart = vi.fn();
    const { container } = render(
      <ServiceCard service={svc({ active: false, activeState: 'failed', status: 'failed' })} httpsDomains={new Set()} {...handlers} onRestart={onRestart} />,
    );
    screen.getByRole('button', { name: /restart/i }).click();
    expect(onRestart).toHaveBeenCalledOnce();
    const html = container.innerHTML;
    expect(html).not.toMatch(/bg-(green|red|amber|blue|cyan|orange|emerald|indigo)-\d/);
    expect(html).not.toMatch(/text-gray-\d/);
  });
});
