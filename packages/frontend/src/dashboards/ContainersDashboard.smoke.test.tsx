/**
 * ContainersDashboard render smoke test (#2095).
 *
 * Status→Containers used to be a flat table while /services is stack-grouped.
 * This mounts the dashboard so the render path exercises the new grouping
 * optic: containers render under labelled SectionHeading sections (a "Core
 * services" section for the reverse-proxy/system containers, owning-stack
 * sections for the rest) using the same Card surface as /services — and all
 * container data (name, image, status) is preserved.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const twinRef: { current: unknown } = { current: null };

vi.mock('@/hooks/useDigitalTwin', () => ({
  useDigitalTwin: () => ({
    data: twinRef.current,
    isConnected: true,
    isNodeSynced: () => true,
  }),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/status',
}));
vi.mock('@/hooks/useContainerActions', () => ({
  useContainerActions: () => ({
    openActions: vi.fn(),
    closeActions: vi.fn(),
    overlay: null,
    isOpen: false,
  }),
}));
vi.mock('@/hooks/useEscapeKey', () => ({ useEscapeKey: () => {} }));

import ContainersDashboard from './ContainersDashboard';

// A box with two services (nginx in the atomic-wipe core stack; immich a
// feature stack) each owning one container, plus a loose standalone container.
function makeTwin() {
  return {
    nodes: {
      Local: {
        services: [
          { name: 'nginx.service', associatedContainerIds: ['nginx-c'] },
          { name: 'immich.service', associatedContainerIds: ['immich-c'] },
        ],
        containers: [
          { id: 'nginx-c', names: ['/nginx'], image: 'nginx:latest', state: 'running', status: 'Up', created: 0, ports: [] },
          { id: 'immich-c', names: ['/immich-server'], image: 'immich:v1', state: 'running', status: 'Up', created: 0, ports: [] },
          { id: 'loose-c', names: ['/loose'], image: 'busybox', state: 'exited', status: 'Exited', created: 0, ports: [] },
        ],
        unmanagedBundles: [],
      },
    },
  };
}

const STACKS = {
  stacks: [
    { name: 'basic', manifest: { name: 'basic', label: 'Core', tier: 'core', lifecycle: 'atomic-wipe', dependsOnStacks: [], templates: ['nginx', 'auth'] } },
    { name: 'immich', manifest: { name: 'immich', label: 'Photos', tier: 'feature', lifecycle: 'wipeable', dependsOnStacks: [], templates: ['immich'] } },
  ],
};

beforeEach(() => {
  twinRef.current = makeTwin();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/system/stacks')) {
      return { ok: true, json: async () => STACKS };
    }
    return { ok: true, json: async () => ({}) };
  }));
});

describe('ContainersDashboard grouping optic (#2095)', () => {
  it('renders containers in labelled stack-grouped sections, not a flat table', async () => {
    render(<ContainersDashboard />);

    // The grouped container wrapper is present (replaces the flat table).
    expect(await screen.findByTestId('containers-stack-groups')).toBeDefined();

    // Core services section (nginx is in the atomic-wipe core stack) renders
    // once the stack manifests load.
    await waitFor(() => {
      expect(screen.getByTestId('container-group-__core__')).toBeDefined();
    });
    expect(screen.getByText('Core services')).toBeDefined();
    expect(screen.getByText('Photos')).toBeDefined();

    // All container data is preserved — names + images still render.
    expect(screen.getByText('immich-server')).toBeDefined();
    expect(screen.getByText('immich:v1')).toBeDefined();
    expect(screen.getByText('nginx:latest')).toBeDefined();
  });
});
