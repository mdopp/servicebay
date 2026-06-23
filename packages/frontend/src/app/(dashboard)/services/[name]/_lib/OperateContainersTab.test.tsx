/**
 * OperateContainersTab migration (#2078) — the empty state is a token-styled
 * <Card>, not the old dashed-gray placeholder; the populated state delegates to
 * ContainerList (DataTable, covered by ContainerList.test).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import OperateContainersTab from './OperateContainersTab';

vi.mock('@/hooks/useDigitalTwin', () => ({ useDigitalTwin: () => ({ data: null }) }));

function svc(over: Partial<ServiceViewModel> = {}): ServiceViewModel {
  return {
    name: 'immich.service',
    displayName: 'Immich',
    yamlBasename: null,
    kubeBasename: null,
    active: true,
    type: 'kube',
    ports: [],
    attachedContainers: [],
    ...over,
  };
}

describe('OperateContainersTab (#2078 migration)', () => {
  it('renders the empty state on a token-styled Card (no dashed gray literal)', () => {
    const { container } = render(<OperateContainersTab service={svc()} />);
    expect(screen.getByText(/No containers are currently running/)).toBeDefined();
    expect(container.innerHTML).not.toContain('border-dashed');
  });
});
