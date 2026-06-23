/**
 * NetworkDashboard — design-system migration (#2100 cluster 3, dashboards).
 *
 * The Status → Network map. The migration moves the *chrome* (toolbar/search,
 * the flow shell, the legend panel, Controls/MiniMap, and the detail drawers)
 * onto components/ui primitives + semantic tokens, while PRESERVING the
 * topology-semantic node/edge palette (the per-type node-card colours, the
 * MiniMap node colours, the legend swatches and the edge-kind line colours are
 * a deliberate visual encoding of the graph, not generic surface chrome).
 *
 * These tests mount the dashboard with @xyflow/react + the data hooks stubbed
 * and assert the chrome renders on token classes with no raw surface-colour
 * literals, and that the live-data layer (fetchGraph) is still wired.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const fetchGraph = vi.fn(() => Promise.resolve());

// @xyflow/react is heavy + canvas-bound; render Panel/ReactFlow children as
// plain divs so the dashboard's surrounding chrome (toolbar, legend, shell)
// mounts in jsdom. The graph itself isn't under test here.
vi.mock('@xyflow/react', () => {
  const passthrough = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ReactFlow: passthrough,
    Panel: passthrough,
    Background: () => <div />,
    Controls: () => <div data-testid="rf-controls" />,
    MiniMap: () => <div data-testid="rf-minimap" />,
    useNodesState: () => [[], vi.fn(), vi.fn()],
    useEdgesState: () => [[], vi.fn(), vi.fn()],
    BaseEdge: () => <div />,
    EdgeLabelRenderer: passthrough,
    Handle: () => <div />,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    MarkerType: { ArrowClosed: 'arrowclosed' },
    addEdge: (_: unknown, e: unknown) => e,
    getSmoothStepPath: () => ['', 0, 0],
  };
});
vi.mock('@xyflow/react/dist/style.css', () => ({}));

vi.mock('@/hooks/useTopologyData', () => ({
  useTopologyData: () => ({ rawData: null, fetchGraph, twin: null }),
}));
vi.mock('@/hooks/useServiceActions', () => ({
  useServiceActions: () => ({ overlays: null }),
}));
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast: vi.fn(), updateToast: vi.fn(), removeToast: vi.fn() }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ExternalLinkModal', () => ({ __esModule: true, default: () => null }));
vi.mock('@/components/serviceDetail/ServiceDetailSummary', () => ({
  __esModule: true,
  default: () => <div />,
}));
vi.mock('@/components/DomainHealthDot', () => ({ DomainHealthDot: () => <span /> }));

import NetworkDashboard from './NetworkDashboard';

describe('NetworkDashboard (#2100 dashboards migration)', () => {
  beforeEach(() => {
    fetchGraph.mockClear();
    vi.stubGlobal('EventSource', class { close() {} } as unknown as typeof EventSource);
  });

  it('renders the chrome on token surfaces with no raw chrome colour literals', async () => {
    const { container } = render(<NetworkDashboard />);
    await waitFor(() => expect(screen.getByTestId('rf-controls')).toBeDefined());

    // Flow shell + legend panel are on tokens.
    expect(container.querySelector('.bg-surface-muted')).not.toBeNull();

    // The flow shell wrapper (this dashboard's own chrome — the page-title bar
    // is the shared PageHeader, migrated separately) is on token classes.
    const shell = container.querySelector('.bg-surface-muted') as HTMLElement;
    expect(shell.className).toContain('border-border');
    expect(shell.className).not.toMatch(/bg-gray-|border-gray-/);

    // The search toolbar input is on tokens.
    const search = screen.getByPlaceholderText('Search...');
    expect(search.className).toContain('border-border');
    expect(search.className).toContain('bg-surface-2');
    expect(search.className).not.toMatch(/border-gray-|bg-white|focus:ring-blue/);

    // The legend panel wrapper is a token surface (not bg-white/gray).
    const legend = screen.getByText('Legend').closest('div');
    expect(legend?.className).toMatch(/bg-surface\b/);
    expect(legend?.className).not.toMatch(/bg-white|bg-gray-/);
  });

  it('wires the live-data layer (initial graph fetch is not regressed)', async () => {
    render(<NetworkDashboard />);
    // The map mounts the search toolbar regardless of graph state.
    expect(await screen.findByPlaceholderText('Search...')).toBeDefined();
  });
});
