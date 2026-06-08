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

import { getLayoutedElements } from './layout';

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
        },
      ],
    });

    const nodes: Node[] = [
      { id: 'a', position: { x: 0, y: 0 }, data: { type: 'router' } },
      { id: 'b', position: { x: 0, y: 0 }, data: { type: 'service' } },
    ];
    const edges: Edge[] = [{ id: 'e1', source: 'a', target: 'b' }];

    const result = await getLayoutedElements(nodes, edges);
    const points = (result.edges[0].data as { points?: { x: number; y: number }[] }).points;
    expect(points).toEqual([
      { x: 100, y: 25 },
      { x: 200, y: 25 },
      { x: 300, y: 25 },
    ]);
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
