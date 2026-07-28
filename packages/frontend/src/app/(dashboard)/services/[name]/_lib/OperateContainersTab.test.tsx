/**
 * OperateContainersTab migration (#2078) — the empty state is a token-styled
 * <Card>, not the old dashed-gray placeholder; the populated state delegates to
 * ContainerList (DataTable, covered by ContainerList.test).
 *
 * Plus #2391: this tab is where the summary's "Logs" quick action lands, so a
 * drawer request with no explicit container must resolve to the service's own
 * first container and be handed to ContainerList.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ServiceViewModel } from '@servicebay/api-client';
import OperateContainersTab from './OperateContainersTab';

vi.mock('@/hooks/useDigitalTwin', () => ({ useDigitalTwin: () => ({ data: null }) }));

const containerListProps = vi.fn();
vi.mock('@/components/ContainerList', () => ({
  default: (props: Record<string, unknown>) => {
    containerListProps(props);
    return null;
  },
}));

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

describe('OperateContainersTab log drawer (#2391)', () => {
  beforeEach(() => { containerListProps.mockClear(); });

  const withContainers = svc({
    attachedContainers: [
      { id: 'abc123', names: ['immich-server'] },
      { id: 'def456', names: ['immich-redis'] },
    ] as ServiceViewModel['attachedContainers'],
  });

  it('resolves a container-less logs request to the service\'s first container', () => {
    render(<OperateContainersTab service={withContainers} initialDrawer={{ mode: 'logs', nonce: 1 }} />);
    expect(containerListProps.mock.calls.at(-1)![0].initialDrawer).toEqual({
      containerId: 'abc123',
      mode: 'logs',
      nonce: 1,
    });
  });

  it('honours an explicit container id and passes no drawer when none is requested', () => {
    render(<OperateContainersTab service={withContainers} initialDrawer={{ containerId: 'def456', mode: 'logs' }} />);
    expect(containerListProps.mock.calls.at(-1)![0].initialDrawer).toMatchObject({ containerId: 'def456' });

    containerListProps.mockClear();
    render(<OperateContainersTab service={withContainers} />);
    expect(containerListProps.mock.calls.at(-1)![0].initialDrawer).toBeNull();
  });
});
