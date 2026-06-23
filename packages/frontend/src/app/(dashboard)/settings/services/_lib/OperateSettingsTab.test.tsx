/**
 * OperateSettingsTab migration (#2078) — config sections wrapped in <Card> with
 * a <SectionHeading>. The non-editable branch (non-kube service) is the cheapest
 * deterministic render and locks the Card surface + token text (no dashed
 * gray-border literal).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import OperateSettingsTab from './OperateSettingsTab';

vi.mock('@/providers/ToastProvider', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/components/ServiceForm', () => ({ default: () => null }));

function svc(over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return {
    name: 'pihole.service',
    displayName: 'Pi-hole',
    yamlBasename: null,
    kubeBasename: null,
    active: true,
    type: 'container',
    ports: [],
    ...over,
  };
}

describe('OperateSettingsTab (#2078 migration)', () => {
  it('renders the non-editable notice on a token-styled Card (no dashed gray literal)', () => {
    const { container } = render(<OperateSettingsTab service={svc({ type: 'container' })} />);
    expect(screen.getByText(/not managed via a Quadlet kube manifest/)).toBeDefined();
    expect(container.innerHTML).not.toContain('border-dashed');
    expect(container.innerHTML).not.toContain('text-gray-600');
  });
});
