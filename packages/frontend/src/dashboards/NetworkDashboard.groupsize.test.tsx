/**
 * #2194/#2198 — service-group container sizing.
 *
 * #2191 fixed the BACKEND ELK geometry (a compound group grows to enclose its
 * children; child positions are parent-relative). #2194 then patched child
 * heights at the RENDER layer via a frontend `applyChildSlotHeights` band-aid,
 * because leaf children came out of layout with `style.height: undefined`.
 *
 * #2198 removes that band-aid: with root INCLUDE_CHILDREN, `getLayoutedElements`
 * lays each child out at a real ELK box and now stamps the ELK-computed
 * width/height DIRECTLY onto the child leaf node — so the child card renders
 * `h-full overflow-hidden` and fills exactly its slot with no post-processing.
 *
 * Assertions:
 *  1. `getLayoutedElements` leaves the GROUP node at its ELK-computed
 *     width/height (NOT the pre-layout 400×200 guess) and gives every child
 *     leaf a DEFINITE height, so consecutive children never overlap.
 *  2. `CustomNode` RENDERS a slot-sized child leaf with `h-full overflow-hidden`
 *     (fills exactly its slot) instead of `h-auto` (overflow → stack).
 *
 * Both would FAIL on the pre-fix behaviour (child height `undefined` / `h-auto`).
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Node, Edge } from '@xyflow/react';
import { getLayoutedElements } from '@servicebay/api-client';
import { type GraphNodeData } from './_lib/networkDashboard';

// Keep @xyflow/react's canvas-bound pieces inert in jsdom; CustomNode only
// needs Handle/Position to render its wrapper markup.
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Handle: () => <div data-testid="rf-handle" />,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  };
});
vi.mock('@xyflow/react/dist/style.css', () => ({}));

const childNode = (id: string, parent: string, ports: number): Node<GraphNodeData> =>
  ({
    id,
    type: 'custom',
    position: { x: 0, y: 0 },
    parentId: parent,
    data: {
      type: 'container',
      label: id,
      parentNode: parent,
      rawData: { ports: Array.from({ length: ports }, (_, i) => 3000 + i) },
    },
  }) as Node<GraphNodeData>;

async function layoutServiceWith(childPorts: number[]) {
  const nodes: Node<GraphNodeData>[] = [
    {
      id: 'svc',
      type: 'custom',
      position: { x: 0, y: 0 },
      // The pre-layout hardcoded guess the frontend seeds group nodes with.
      style: { width: 400, height: 200 },
      data: { type: 'service', label: 'file-share' },
    } as Node<GraphNodeData>,
    ...childPorts.map((p, i) => childNode(`c${i + 1}`, 'svc', p)),
  ];
  const laidOut = await getLayoutedElements(nodes, [] as Edge[]);
  return laidOut.nodes as Node<GraphNodeData>[];
}

describe('#2194/#2198 service-group sizing', () => {
  it('keeps the ELK-computed group size (not 400×200) and grows with container count', async () => {
    const three = await layoutServiceWith([1, 3, 2]);
    const four = await layoutServiceWith([1, 3, 2, 4]);

    const svc3 = three.find((n) => n.id === 'svc')!;
    const svc4 = four.find((n) => n.id === 'svc')!;
    const h3 = (svc3.style as { height?: number }).height!;
    const w3 = (svc3.style as { width?: number }).width!;
    const h4 = (svc4.style as { height?: number }).height!;

    // Criterion 1: the rendered group uses the ELK-computed size, NOT the
    // hardcoded pre-layout 400×200 guess, and grows with container count.
    expect(w3).not.toBe(400);
    expect(h3).not.toBe(200);
    expect(typeof h3).toBe('number');
    expect(h4).toBeGreaterThan(h3); // one more container → taller enclosing box
  });

  it('gives every child a definite, non-overlapping slot height (was undefined → h-auto stack)', async () => {
    const sized = await layoutServiceWith([1, 6, 2]); // varied content per child
    const kids = sized
      .filter((n) => n.parentId === 'svc')
      .sort((a, b) => a.position.y - b.position.y);

    expect(kids).toHaveLength(3);
    for (const k of kids) {
      const h = (k.style as { height?: number } | undefined)?.height;
      // Criterion 3 regression: pre-fix this was `undefined` (h-auto → stack).
      expect(typeof h).toBe('number');
      expect(h!).toBeGreaterThan(0);
    }

    // Criterion 2: each child's [y, y+height] slot ends at/before the next
    // child's y — zero child↔child overlap inside the parent rect.
    for (let i = 0; i < kids.length - 1; i++) {
      const bottom = kids[i].position.y + (kids[i].style as { height?: number }).height!;
      const nextTop = kids[i + 1].position.y;
      expect(bottom).toBeLessThanOrEqual(nextTop + 1); // +1 for rounding
    }
  });

  it('renders a slot-sized child leaf that fills its slot (h-full overflow-hidden, not h-auto)', async () => {
    // Lazy import so the @xyflow/react mock is installed before the module
    // graph resolves the dashboard's Handle/Position usage.
    const { CustomNode } = await import('./NetworkDashboard');

    const childData: GraphNodeData = {
      type: 'container',
      label: 'c1',
      parentNode: 'svc',
      status: 'up',
      rawData: { ports: [3000] },
    };
    const { container: childHost } = render(
      // @ts-expect-error — NodeProps carries many optional RF fields the render
      // path doesn't read; the test supplies only id + data.
      <CustomNode id="c1" data={childData} />,
    );
    const childWrapper = childHost.querySelector('div');
    expect(childWrapper?.className).toContain('h-full');
    expect(childWrapper?.className).toContain('overflow-hidden');
    expect(childWrapper?.className).not.toContain('h-auto');

    // A top-level (parentless) card keeps h-auto — the fix is scoped to children.
    const topData: GraphNodeData = { type: 'container', label: 'top', status: 'up', rawData: {} };
    const { container: topHost } = render(
      // @ts-expect-error — see above.
      <CustomNode id="top" data={topData} />,
    );
    const topWrapper = topHost.querySelector('div');
    expect(topWrapper?.className).toContain('h-auto');
  });
});

const _renderTypeGuard: ReactNode = null;
void _renderTypeGuard;
