import { describe, it, expect, vi } from 'vitest';
import type { Node, Edge } from '@xyflow/react';

// #1782 — drive ELK with a deterministic stub so we can assert how the
// orthogonal routing sections are read back and attached to the React Flow
// edges. The real elkjs WASM layout is non-deterministic and slow; the
// contract we care about here is the point extraction + parent offsetting.
const { layoutMock } = vi.hoisted(() => ({ layoutMock: vi.fn() }));

vi.mock('elkjs/lib/elk.bundled.js', () => {
  return {
    default: class {
      layout = layoutMock;
    },
  };
});

vi.mock('../logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getLayoutedElements, segmentCrossing, computeEdgeHops } from './layout';

describe('getLayoutedElements — ELK orthogonal routing (#1782)', () => {
  it('attaches absolute orthogonal points for a root edge', async () => {
    layoutMock.mockResolvedValueOnce({
      id: 'root',
      children: [
        { id: 'a', x: 0, y: 0, width: 100, height: 50, children: [] },
        { id: 'b', x: 300, y: 0, width: 100, height: 50, children: [] },
      ],
      edges: [
        {
          id: 'e1',
          sources: ['a'],
          targets: ['b'],
          sections: [
            {
              id: 's1',
              startPoint: { x: 100, y: 25 },
              bendPoints: [{ x: 200, y: 25 }],
              endPoint: { x: 300, y: 25 },
            },
          ],
          // #1783 — ELK reports the CENTER-placed label box (top-left x/y).
          labels: [{ text: ':2283', x: 180, y: 18, width: 42, height: 15 }],
        },
      ],
    });

    const nodes: Node[] = [
      { id: 'a', position: { x: 0, y: 0 }, data: { type: 'router' } },
      { id: 'b', position: { x: 0, y: 0 }, data: { type: 'service' } },
    ];
    const edges: Edge[] = [{ id: 'e1', source: 'a', target: 'b', label: ':2283' }];

    const result = await getLayoutedElements(nodes, edges);
    const points = (result.edges[0].data as { points?: { x: number; y: number }[] }).points;
    expect(points).toEqual([
      { x: 100, y: 25 },
      { x: 200, y: 25 },
      { x: 300, y: 25 },
    ]);
    // #1783 — label position read back as the box CENTER (top-left + half size).
    const lpos = (result.edges[0].data as { lpos?: { x: number; y: number } }).lpos;
    expect(lpos).toEqual({ x: 180 + 42 / 2, y: 18 + 15 / 2 });
  });

  it('attaches no lpos when ELK placed no label box (#1783)', async () => {
    layoutMock.mockResolvedValueOnce({
      id: 'root',
      children: [
        { id: 'a', x: 0, y: 0, width: 100, height: 50, children: [] },
        { id: 'b', x: 300, y: 0, width: 100, height: 50, children: [] },
      ],
      edges: [
        {
          id: 'e1',
          sources: ['a'],
          targets: ['b'],
          sections: [
            { id: 's1', startPoint: { x: 100, y: 25 }, endPoint: { x: 300, y: 25 } },
          ],
        },
      ],
    });

    const nodes: Node[] = [
      { id: 'a', position: { x: 0, y: 0 }, data: { type: 'router' } },
      { id: 'b', position: { x: 0, y: 0 }, data: { type: 'service' } },
    ];
    // No label and no port → no chip text → no lpos.
    const edges: Edge[] = [{ id: 'e1', source: 'a', target: 'b' }];

    const result = await getLayoutedElements(nodes, edges);
    expect((result.edges[0].data as { lpos?: unknown }).lpos).toBeUndefined();
  });

  it('offsets points for an edge nested inside a compound parent', async () => {
    // Edge declared inside group `g` (absolute origin 500,100); its section
    // coords are relative to the parent and must be shifted to absolute.
    layoutMock.mockResolvedValueOnce({
      id: 'root',
      children: [
        {
          id: 'g',
          x: 500,
          y: 100,
          width: 400,
          height: 200,
          children: [
            { id: 'c1', x: 20, y: 20, width: 80, height: 40, children: [] },
            { id: 'c2', x: 220, y: 20, width: 80, height: 40, children: [] },
          ],
          edges: [
            {
              id: 'e-nested',
              sources: ['c1'],
              targets: ['c2'],
              sections: [
                {
                  id: 's',
                  startPoint: { x: 100, y: 40 },
                  endPoint: { x: 220, y: 40 },
                },
              ],
            },
          ],
        },
      ],
      edges: [],
    });

    const nodes: Node[] = [
      { id: 'g', position: { x: 0, y: 0 }, data: { type: 'group' } },
      { id: 'c1', parentId: 'g', position: { x: 0, y: 0 }, data: { type: 'container' } },
      { id: 'c2', parentId: 'g', position: { x: 0, y: 0 }, data: { type: 'container' } },
    ];
    const edges: Edge[] = [{ id: 'e-nested', source: 'c1', target: 'c2' }];

    const result = await getLayoutedElements(nodes, edges);
    const points = (result.edges[0].data as { points?: { x: number; y: number }[] }).points;
    // Parent absolute origin (500,100) added to relative section points.
    expect(points).toEqual([
      { x: 600, y: 140 },
      { x: 720, y: 140 },
    ]);
  });

  it('stamps ELK-computed dimensions as TOP-LEVEL width/height for RF v12 (#2201)', async () => {
    // React Flow v12 reads layout dims from node.width/node.height, not style.
    // Without top-level dims, children with extent:'parent' clamp to (0,0).
    layoutMock.mockResolvedValueOnce({
      id: 'root',
      children: [
        {
          id: 'g',
          x: 500,
          y: 100,
          width: 520,
          height: 610,
          children: [
            { id: 'c1', x: 50, y: 80, width: 440, height: 240, children: [] },
            { id: 'c2', x: 50, y: 340, width: 440, height: 240, children: [] },
          ],
        },
      ],
      edges: [],
    });

    const nodes: Node[] = [
      { id: 'g', position: { x: 0, y: 0 }, data: { type: 'group' } },
      { id: 'c1', parentId: 'g', position: { x: 0, y: 0 }, data: { type: 'container' } },
      { id: 'c2', parentId: 'g', position: { x: 0, y: 0 }, data: { type: 'container' } },
    ];

    const result = await getLayoutedElements(nodes, []);
    const byId = new Map(result.nodes.map((n) => [n.id, n]));

    // Group parent: top-level dims carry the ELK box (RF v12 uses these to
    // compute parent bounds for extent-clamped children).
    const g = byId.get('g')!;
    expect(g.width).toBe(520);
    expect(g.height).toBe(610);

    // Child leaves: top-level dims carry each child's own box so the
    // extent-clamp math places them inside the parent instead of at (0,0).
    const c1 = byId.get('c1')!;
    expect(c1.width).toBe(440);
    expect(c1.height).toBe(240);
    expect(c1.position).toEqual({ x: 50, y: 80 });
    const c2 = byId.get('c2')!;
    expect(c2.width).toBe(440);
    expect(c2.height).toBe(240);
    expect(c2.position).toEqual({ x: 50, y: 340 });
  });

  it('leaves an edge untouched when ELK produced no section for it', async () => {
    layoutMock.mockResolvedValueOnce({
      id: 'root',
      children: [{ id: 'a', x: 0, y: 0, width: 10, height: 10, children: [] }],
      edges: [{ id: 'e1', sources: ['a'], targets: ['a'], sections: [] }],
    });

    const nodes: Node[] = [{ id: 'a', position: { x: 0, y: 0 }, data: { type: 'service' } }];
    const edges: Edge[] = [{ id: 'e1', source: 'a', target: 'a', data: { kind: 'observed' } }];

    const result = await getLayoutedElements(nodes, edges);
    expect((result.edges[0].data as { points?: unknown }).points).toBeUndefined();
    expect((result.edges[0].data as { kind?: string }).kind).toBe('observed');
  });
});

describe('segmentCrossing — H×V intersection (#1784)', () => {
  const h = { edgeId: 'h', x1: 0, y1: 50, x2: 200, y2: 50 };

  it('reports the crossing point of a different edge passing through', () => {
    const v = { edgeId: 'v', x1: 100, y1: 0, x2: 100, y2: 120 };
    expect(segmentCrossing(h, v)).toEqual({ x: 100, y: 50 });
  });

  it('returns null for segments of the SAME edge', () => {
    const v = { edgeId: 'h', x1: 100, y1: 0, x2: 100, y2: 120 };
    expect(segmentCrossing(h, v)).toBeNull();
  });

  it('returns null when the vertical is outside the horizontal x-range', () => {
    const v = { edgeId: 'v', x1: 300, y1: 0, x2: 300, y2: 120 };
    expect(segmentCrossing(h, v)).toBeNull();
  });

  it('returns null when the horizontal is outside the vertical y-range', () => {
    const v = { edgeId: 'v', x1: 100, y1: 0, x2: 100, y2: 10 };
    expect(segmentCrossing(h, v)).toBeNull();
  });

  it('treats a T-junction at the horizontal endpoint as no crossing (margin)', () => {
    // Vertical's x sits right on the horizontal's left endpoint → touch, not cross.
    const v = { edgeId: 'v', x1: 1, y1: 0, x2: 1, y2: 120 };
    expect(segmentCrossing(h, v)).toBeNull();
  });

  it('treats a T-junction at the vertical endpoint as no crossing (margin)', () => {
    // Horizontal's y sits right on the vertical's top endpoint → touch, not cross.
    const v = { edgeId: 'v', x1: 100, y1: 49, x2: 100, y2: 200 };
    expect(segmentCrossing(h, v)).toBeNull();
  });
});

describe('computeEdgeHops — per-edge hop list (#1784)', () => {
  it('places the hop on the horizontal edge only, not the vertical one', () => {
    const points = new Map<string, { x: number; y: number }[]>([
      // Horizontal run at y=50 from x=0..200.
      ['eh', [{ x: 0, y: 50 }, { x: 200, y: 50 }]],
      // Vertical run at x=100 from y=0..120 (different edge) → crosses eh.
      ['ev', [{ x: 100, y: 0 }, { x: 100, y: 120 }]],
    ]);
    const hops = computeEdgeHops(points);
    expect(hops.get('eh')).toEqual([{ x: 100, y: 50 }]);
    expect(hops.get('ev')).toBeUndefined();
  });

  it('sorts multiple hops on one run left→right', () => {
    const points = new Map<string, { x: number; y: number }[]>([
      ['eh', [{ x: 0, y: 50 }, { x: 300, y: 50 }]],
      ['ev2', [{ x: 200, y: 0 }, { x: 200, y: 120 }]],
      ['ev1', [{ x: 80, y: 0 }, { x: 80, y: 120 }]],
    ]);
    const hops = computeEdgeHops(points);
    expect(hops.get('eh')).toEqual([
      { x: 80, y: 50 },
      { x: 200, y: 50 },
    ]);
  });

  it('produces no hops for parallel non-crossing runs', () => {
    const points = new Map<string, { x: number; y: number }[]>([
      ['e1', [{ x: 0, y: 50 }, { x: 200, y: 50 }]],
      ['e2', [{ x: 0, y: 90 }, { x: 200, y: 90 }]],
    ]);
    expect(computeEdgeHops(points).size).toBe(0);
  });
});
