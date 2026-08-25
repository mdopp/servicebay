/* eslint-disable @typescript-eslint/no-explicit-any */

import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

/**
 * #2630 — `processAndLayout` committed `setNodes` / `setEdges` /
 * `laidOutGraphRef.current` unconditionally as soon as the async ELK layout
 * resolved; the `layoutRunRef` / `isStale()` generation guard only covered the
 * POST-layout side effects (focus commit, toast). The layout promise has no
 * guaranteed resolution order, so two topology-changing triggers close together
 * could resolve out of order and the older run's commit silently overwrote the
 * newer one — the map snapped back to a stale arrangement, no error shown.
 *
 * Determinism: the ELK layout call (`getLayoutedElements`) is replaced by a
 * promise the TEST holds open. Every call parks a `{nodes, edges, resolve}`
 * record in `pending[]`, and the test resolves them in an explicitly chosen
 * order. Nothing here depends on timing, scheduling or a race window — the
 * out-of-order resolution is spelled out as a sequence of calls.
 */

const held = vi.hoisted(() => ({
  pending: [] as { ids: string[]; resolve: (value: unknown) => void }[],
}));

// The ELK layout, held open. Everything else in the api-client stays real.
vi.mock('@servicebay/api-client', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getLayoutedElements: (nodes: any[], edges: any[]) =>
      new Promise((resolve) => {
        held.pending.push({
          ids: nodes.map((n) => n.id),
          resolve: () => resolve({ nodes, edges }),
        });
      }),
  };
});

vi.mock('@/hooks/useDigitalTwin', () => ({ useDigitalTwin: () => ({ data: null, loading: false }) }));

const toast = vi.hoisted(() => ({ addToast: vi.fn(() => 'toast-id'), updateToast: vi.fn(), removeToast: vi.fn() }));
vi.mock('@/providers/ToastProvider', () => ({ useToast: () => toast, ToastType: {} }));

vi.mock('react-highlight-words', () => ({ default: ({ textToHighlight }: any) => <>{textToHighlight}</> }));

// React Flow needs ResizeObserver + canvas; render a flat DOM stand-in that
// exposes each node id and the group toggle the dashboard attaches to it.
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes }: any) => (
    <div data-testid="react-flow-mock">
      {nodes?.map((n: any) => (
        <div key={n.id} data-testid={`node-${n.id}`}>
          {n.data?.label}
          {n.data?.onToggle && (
            <button data-testid={`toggle-${n.id}`} onClick={() => n.data.onToggle(n.id)}>
              toggle
            </button>
          )}
        </div>
      ))}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Panel: ({ children }: any) => <div>{children}</div>,
  useNodesState: (initial: any) => React.useState(initial),
  useEdgesState: (initial: any) => React.useState(initial),
  addEdge: vi.fn(),
  getSmoothStepPath: vi.fn().mockReturnValue(['M0 0', 0, 0]),
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: any) => <div>{children}</div>,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  Handle: () => null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  usePathname: () => '/network',
  useSearchParams: () => new URLSearchParams(),
}));

Object.defineProperty(global, 'EventSource', {
  writable: true,
  value: class MockEventSource {
    url: string;
    onmessage: unknown;
    constructor(url: string) { this.url = url; }
    close() {}
  },
});

import NetworkDashboard from '@/dashboards/NetworkDashboard';

/** Two collapsible groups, one child each — expanding either changes topology. */
const GRAPH = {
  nodes: [
    { id: 'internet', label: 'Internet', type: 'internet', status: 'up' },
    { id: 'svc-a', label: 'Service A', type: 'group', status: 'up' },
    { id: 'a-web', label: 'a-web', type: 'container', status: 'up', parentNode: 'svc-a' },
    { id: 'svc-b', label: 'Service B', type: 'group', status: 'up' },
    { id: 'b-web', label: 'b-web', type: 'container', status: 'up', parentNode: 'svc-b' },
  ],
  edges: [
    { id: 'e-1', source: 'internet', target: 'svc-a', port: 443, kind: 'observed' },
    { id: 'e-2', source: 'internet', target: 'svc-b', port: 443, kind: 'observed' },
  ],
};

describe('NetworkDashboard layout-commit race (#2630)', () => {
  beforeEach(() => {
    held.pending = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => GRAPH })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /** Resolve the layout call at `index`, oldest-first indices staying stable. */
  const settle = async (index: number) => {
    const run = held.pending[index];
    expect(run).toBeDefined();
    await act(async () => {
      run.resolve(undefined);
      await Promise.resolve();
    });
  };

  /** Answer every layout call parked so far, oldest first. */
  const settleAll = async () => {
    const count = held.pending.length;
    for (let i = 0; i < count; i++) await settle(i);
  };

  /** Mount, let the initial (all-groups-collapsed) layout commit. */
  const mountAndSettleInitialLayout = async () => {
    render(<NetworkDashboard />);
    await waitFor(() => expect(held.pending.length).toBeGreaterThan(0));
    await settleAll();
    await waitFor(() => expect(screen.getByTestId('node-svc-a')).toBeTruthy());
    // Both groups start collapsed, so neither child is on the map yet.
    expect(screen.queryByTestId('node-a-web')).toBeNull();
    expect(screen.queryByTestId('node-b-web')).toBeNull();
    held.pending = [];
  };

  /** Expand svc-a, then svc-b — two topology changes, both layouts held open. */
  const expandBothGroups = async () => {
    fireEvent.click(screen.getByTestId('toggle-svc-a'));
    await waitFor(() => expect(held.pending.some(p => p.ids.includes('a-web'))).toBe(true));
    const older = held.pending.findIndex(p => p.ids.includes('a-web') && !p.ids.includes('b-web'));

    fireEvent.click(screen.getByTestId('toggle-svc-b'));
    await waitFor(() => expect(held.pending.some(p => p.ids.includes('b-web'))).toBe(true));
    const newer = held.pending.findIndex(p => p.ids.includes('b-web'));

    expect(older).toBeGreaterThanOrEqual(0);
    expect(newer).toBeGreaterThan(older);
    return { older, newer };
  };

  it('reproduces the race: the superseded layout resolving LAST must not revert the map', async () => {
    await mountAndSettleInitialLayout();
    const { older, newer } = await expandBothGroups();

    // Out-of-order: the newest run answers first, the superseded one lands after.
    await settle(newer);
    await waitFor(() => expect(screen.getByTestId('node-b-web')).toBeTruthy());
    await settle(older);

    // The stale commit must not have dropped svc-b's child back off the map.
    expect(screen.queryByTestId('node-b-web')).not.toBeNull();
    expect(screen.queryByTestId('node-a-web')).not.toBeNull();
  });

  it('in-order resolution commits the newest topology just the same', async () => {
    await mountAndSettleInitialLayout();
    const { older, newer } = await expandBothGroups();

    await settle(older);
    await settle(newer);

    await waitFor(() => expect(screen.getByTestId('node-b-web')).toBeTruthy());
    expect(screen.queryByTestId('node-a-web')).not.toBeNull();
  });

  it('the superseded run stamps no layout signature, so a later real change still re-lays out', async () => {
    await mountAndSettleInitialLayout();
    const { older, newer } = await expandBothGroups();

    await settle(newer);
    await settle(older); // superseded — commits nothing, its signature included
    held.pending = [];

    // Collapsing svc-b again lands on exactly the topology the superseded run
    // was laying out. If that run had stamped its signature, the dashboard
    // would read the change as "topology unchanged" and merge in place instead
    // of re-laying out — and svc-b's child would stay on the collapsed group.
    fireEvent.click(screen.getByTestId('toggle-svc-b'));
    await waitFor(() => expect(held.pending.length).toBeGreaterThan(0), { timeout: 1000 });
    await settleAll();

    await waitFor(() => expect(screen.queryByTestId('node-b-web')).toBeNull());
    expect(screen.queryByTestId('node-a-web')).not.toBeNull();
  });

  it('happy path: a single topology change still commits its layout', async () => {
    await mountAndSettleInitialLayout();

    fireEvent.click(screen.getByTestId('toggle-svc-a'));
    await waitFor(() => expect(held.pending.some(p => p.ids.includes('a-web'))).toBe(true));
    await settleAll();

    await waitFor(() => expect(screen.getByTestId('node-a-web')).toBeTruthy());
    expect(screen.queryByTestId('node-b-web')).toBeNull();
  });
});
