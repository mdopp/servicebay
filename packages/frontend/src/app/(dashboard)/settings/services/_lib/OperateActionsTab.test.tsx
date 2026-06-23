/**
 * OperateActionsTab migration (#2078). Operator said the actions "wirken
 * deplaziert": a mixed 2-col / full-width / oversized layout. These tests lock
 * the rebuild onto the shared <Button> primitive in a consistent grid, grouped
 * under <SectionHeading> sections, with the delete as a danger-variant button.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import OperateActionsTab from './OperateActionsTab';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn() }),
}));
vi.mock('@/components/ActionProgressModal', () => ({ default: () => null }));
vi.mock('@/components/ConfirmModal', () => ({ default: () => null }));

function svc(over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return {
    name: 'immich.service',
    displayName: 'Immich',
    yamlBasename: null,
    kubeBasename: null,
    active: true,
    type: 'kube',
    ports: [],
    ...over,
  };
}

describe('OperateActionsTab (#2078 layout)', () => {
  it('renders the lifecycle actions as uniform buttons under section headings', () => {
    render(<OperateActionsTab service={svc()} />);
    for (const label of ['Start', 'Stop', 'Restart', 'Update & Restart', 'Back up config to NAS']) {
      // exact name match — 'Restart' must not also match 'Update & Restart'
      expect(screen.getByRole('button', { name: label })).toBeDefined();
    }
    // section headings group them (Lifecycle / Data / Danger zone)
    expect(screen.getByText('Lifecycle')).toBeDefined();
    expect(screen.getByText('Data')).toBeDefined();
    expect(screen.getByText('Danger zone')).toBeDefined();
  });

  it('renders Delete service as a danger-variant Button (no ad-hoc red box)', () => {
    render(<OperateActionsTab service={svc()} />);
    const del = screen.getByRole('button', { name: /Delete service/ });
    expect(del.getAttribute('data-variant')).toBe('danger');
  });

  it('uses no raw red/green/blue colour literals on the action controls', () => {
    const { container } = render(<OperateActionsTab service={svc()} />);
    const html = container.innerHTML;
    for (const banned of ['text-green-500', 'text-red-500', 'text-orange-500', 'bg-red-50', 'border-red-200']) {
      expect(html).not.toContain(banned);
    }
  });
});
