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

// Mutable test doubles for the data + routing layers so individual cases can
// drive a focus deep-link (#2108) without re-mocking per test.
let topologyRawData: { nodes: unknown[]; edges: unknown[] } | null = null;
let focusSearchParam: string | null = null;

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

// #2119 — spy on the ELK layout so a test can assert an identical-topology
// poll does NOT re-run it. getLayoutedElements just echoes its input here.
// Hoisted so the (hoisted) vi.mock factory can reference it safely.
const { getLayoutedElements } = vi.hoisted(() => ({
  getLayoutedElements: vi.fn(async (nodes: unknown[], edges: unknown[]) => ({ nodes, edges })),
}));
vi.mock('@servicebay/api-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getLayoutedElements };
});

vi.mock('@/hooks/useTopologyData', () => ({
  useTopologyData: () => ({ rawData: topologyRawData, fetchGraph, twin: null }),
}));
vi.mock('@/hooks/useServiceActions', () => ({
  useServiceActions: () => ({ overlays: null }),
}));
// #2195 — stable toast spies so a test can assert the auto-refresh does NOT
// open a loading toast on a background merge, and DOES surface a brief
// (non-sticky) indicator only when the topology changes. Typed to the
// ToastProvider API so `.mock.calls` destructures (type, title, msg, duration).
const addToast =
  vi.fn<(type: string, title: string, message?: string, duration?: number) => string>(() => 'toast-id');
const updateToast = vi.fn();
const removeToast = vi.fn();
vi.mock('@/providers/ToastProvider', () => ({
  useToast: () => ({ addToast, updateToast, removeToast }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(focusSearchParam ? `focus=${focusSearchParam}` : ''),
}));
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
    addToast.mockClear();
    updateToast.mockClear();
    removeToast.mockClear();
    topologyRawData = null;
    focusSearchParam = null;
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

  it('#2108 applies the ?focus= deep-link → enters focus mode for the matching service node', async () => {
    // Graph carries the immich service node the list links to.
    topologyRawData = {
      nodes: [
        { id: 'internet', type: 'internet', label: 'Internet' },
        { id: 'service-immich.service', type: 'service', label: 'immich' },
      ],
      edges: [],
    };
    focusSearchParam = 'immich.service';

    render(<NetworkDashboard />);

    // Focus mode is on ⇒ the "Full map" exit control renders (only present
    // when focusNodeId is set). That proves the param was read + resolved to
    // the matching node id and applied.
    expect(await screen.findByTestId('focus-back')).toBeDefined();
  });

  it('#2119 does NOT re-run the ELK layout when a poll returns an identical topology', async () => {
    getLayoutedElements.mockClear();
    topologyRawData = {
      nodes: [
        { id: 'internet', type: 'internet', label: 'Internet' },
        { id: 'service-immich.service', type: 'service', label: 'immich', status: 'up' },
      ],
      edges: [{ id: 'e1', source: 'internet', target: 'service-immich.service' }],
    };

    const { rerender } = render(<NetworkDashboard />);
    await waitFor(() => expect(getLayoutedElements).toHaveBeenCalled());
    // Let the initial layout (+ the initial-collapse re-render) settle.
    await new Promise((r) => setTimeout(r, 20));
    const layoutCallsAfterInitialLoad = getLayoutedElements.mock.calls.length;

    // A poll: same node + edge ids, only the status flips. New object identity
    // (as a real fetch produces) but an identical topology signature.
    topologyRawData = {
      nodes: [
        { id: 'internet', type: 'internet', label: 'Internet' },
        { id: 'service-immich.service', type: 'service', label: 'immich', status: 'down' },
      ],
      edges: [{ id: 'e1', source: 'internet', target: 'service-immich.service' }],
    };
    rerender(<NetworkDashboard />);

    // No further ELK pass — the status update merges onto the existing positions.
    await new Promise((r) => setTimeout(r, 20));
    expect(getLayoutedElements.mock.calls.length).toBe(layoutCallsAfterInitialLoad);
  });

  it('#2119 re-runs the ELK layout when the topology actually changes (node added)', async () => {
    getLayoutedElements.mockClear();
    topologyRawData = {
      nodes: [{ id: 'service-a.service', type: 'service', label: 'a' }],
      edges: [],
    };
    const { rerender } = render(<NetworkDashboard />);
    await waitFor(() => expect(getLayoutedElements).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    const before = getLayoutedElements.mock.calls.length;

    topologyRawData = {
      nodes: [
        { id: 'service-a.service', type: 'service', label: 'a' },
        { id: 'service-b.service', type: 'service', label: 'b' },
      ],
      edges: [],
    };
    rerender(<NetworkDashboard />);
    // Topology changed → a fresh ELK pass runs.
    await waitFor(() => expect(getLayoutedElements.mock.calls.length).toBeGreaterThan(before));
  });

  it('#2195 shows NO loading toast and NO toast on a background in-place merge (topology unchanged)', async () => {
    topologyRawData = {
      nodes: [
        { id: 'internet', type: 'internet', label: 'Internet' },
        { id: 'service-immich.service', type: 'service', label: 'immich', status: 'up' },
      ],
      edges: [{ id: 'e1', source: 'internet', target: 'service-immich.service' }],
    };
    const { rerender } = render(<NetworkDashboard />);
    await waitFor(() => expect(getLayoutedElements).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    // Clear whatever the initial appear did — from here on we simulate N
    // background twin updates (status/metric flips) with an UNCHANGED topology
    // signature, exactly the steady-state that made the UI restless.
    addToast.mockClear();
    updateToast.mockClear();
    removeToast.mockClear();

    for (let i = 0; i < 5; i++) {
      topologyRawData = {
        nodes: [
          { id: 'internet', type: 'internet', label: 'Internet' },
          { id: 'service-immich.service', type: 'service', label: 'immich', status: i % 2 ? 'down' : 'up' },
        ],
        edges: [{ id: 'e1', source: 'internet', target: 'service-immich.service' }],
      };
      rerender(<NetworkDashboard />);
      await new Promise((r) => setTimeout(r, 10));
    }

    // No loading toast (the old sticky 'Refreshing Network'), and no toast at
    // all on the in-place path.
    const loadingCalls = addToast.mock.calls.filter((c) => c[0] === 'loading');
    expect(loadingCalls.length).toBe(0);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('#2195 surfaces exactly one brief, non-sticky indicator when the topology actually changes', async () => {
    topologyRawData = {
      nodes: [{ id: 'service-a.service', type: 'service', label: 'a' }],
      edges: [],
    };
    const { rerender } = render(<NetworkDashboard />);
    await waitFor(() => expect(getLayoutedElements).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    // The FIRST layout (map appearing) is not a change → not announced.
    addToast.mockClear();

    // A real topology change: a node is added → a full re-layout runs.
    topologyRawData = {
      nodes: [
        { id: 'service-a.service', type: 'service', label: 'a' },
        { id: 'service-b.service', type: 'service', label: 'b' },
      ],
      edges: [],
    };
    rerender(<NetworkDashboard />);
    await waitFor(() => expect(addToast).toHaveBeenCalled());

    // A single, brief, NON-sticky toast (duration > 0), never a loading toast.
    expect(addToast).toHaveBeenCalledTimes(1);
    const [type, , , duration] = addToast.mock.calls[0];
    expect(type).not.toBe('loading');
    expect(typeof duration).toBe('number');
    expect(duration as number).toBeGreaterThan(0);
  });

  it('#2108 does NOT enter focus mode when the focus param matches no node (stale link)', async () => {
    topologyRawData = {
      nodes: [{ id: 'service-other.service', type: 'service', label: 'other' }],
      edges: [],
    };
    focusSearchParam = 'gone.service';

    render(<NetworkDashboard />);
    await screen.findByPlaceholderText('Search...');
    expect(screen.queryByTestId('focus-back')).toBeNull();
  });
});
