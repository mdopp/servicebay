import { describe, it, expect, vi } from 'vitest';
import type { Node, Edge } from '@xyflow/react';

// #2176 — unlike layout.test.ts (which stubs ELK to assert edge-point
// extraction), this suite drives the REAL elkjs layout so we can assert the
// two geometric acceptance criteria of #2176:
//   1. same-layer large group cards never overlap, and
//   2. disconnected components spread across the canvas (bounded aspect
//      ratio) instead of stacking into one dense column.
// elkjs runs synchronously-enough in-process here; only the logger is stubbed.
vi.mock('../logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getLayoutedElements } from './layout';

type Rect = { x: number; y: number; w: number; h: number };

/** Absolute bounding boxes of the laid-out top-level (parentless) nodes. */
function boundingBoxes(nodes: Node[]): Rect[] {
  return nodes
    .filter((n) => !n.parentId)
    .map((n) => ({
      x: n.position.x,
      y: n.position.y,
      w: (n.style?.width as number | undefined) ?? 440,
      h: (n.style?.height as number | undefined) ?? 240,
    }));
}

/** Do two axis-aligned rects overlap by more than `slack` px on BOTH axes? */
function overlaps(a: Rect, b: Rect, slack = 1): boolean {
  const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const yOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return xOverlap > slack && yOverlap > slack;
}

/**
 * Build a large multi-container `service` group card: a collapsed group whose
 * aggregated `summary.portMap` carries `portCount` ports and which advertises
 * verified domains — the exact shape (file-share samba+filebrowser+syncthing,
 * the home-assistant cluster) that overlapped in #2176.
 */
function largeGroupNode(id: string, portCount: number, domains: string[]): Node {
  return {
    id,
    position: { x: 0, y: 0 },
    data: {
      type: 'service',
      label: id,
      collapsed: true,
      status: 'up',
      rawData: { type: 'service', active: true, load: '0.1', hostNetwork: true },
      metadata: { verifiedDomains: domains, description: `${id} bundle` },
      summary: {
        status: 'up',
        verifiedDomains: domains,
        portMap: Array.from({ length: portCount }, (_, i) => ({
          hostPort: 8000 + i,
          containerPort: 8000 + i,
          protocol: 'tcp',
        })),
      },
    },
  } as unknown as Node;
}

describe('getLayoutedElements — same-layer overlap (#2176 criterion 1)', () => {
  it('lays out 3+ large multi-container groups in one layer with zero overlaps', async () => {
    // One hub (proxy) fanning out to four large group cards → all four land in
    // the SAME layer to ELK's right of the hub. With truthful heights they
    // must not overlap.
    const hub: Node = {
      id: 'hub',
      position: { x: 0, y: 0 },
      data: { type: 'proxy', label: 'nginx', status: 'up', rawData: { type: 'proxy' } },
    } as unknown as Node;

    const groups = [
      largeGroupNode('file-share', 6, ['files.example.com', 'sync.example.com']),
      largeGroupNode('home-assistant', 5, ['ha.example.com', 'hass.example.com', 'assist.example.com']),
      largeGroupNode('solaris-chat', 4, ['chat.example.com']),
      largeGroupNode('immich', 5, ['photos.example.com', 'immich.example.com']),
    ];

    const nodes: Node[] = [hub, ...groups];
    const edges: Edge[] = groups.map((g) => ({
      id: `e-hub-${g.id}`,
      source: 'hub',
      target: g.id,
    }));

    const { nodes: laid } = await getLayoutedElements(nodes, edges);
    const boxes = boundingBoxes(laid);

    // Every laid-out node got a real position + size.
    expect(boxes.length).toBe(nodes.length);
    for (const b of boxes) {
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.y)).toBe(true);
      expect(b.h).toBeGreaterThan(0);
    }

    // Zero pairwise bounding-box overlaps.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(
          overlaps(boxes[i], boxes[j]),
          `nodes ${i} and ${j} overlap: ${JSON.stringify(boxes[i])} vs ${JSON.stringify(boxes[j])}`,
        ).toBe(false);
      }
    }
  });
});

describe('getLayoutedElements — component spread (#2176 criterion 2)', () => {
  it('spreads disconnected components into a bounded aspect ratio, not one column', async () => {
    // Six independent (edge-less) service cards — the #2175 anchored/floating
    // shape. separateConnectedComponents + aspectRatio must fan them out so the
    // layout is not a single tall column with an empty left half.
    const nodes: Node[] = Array.from({ length: 6 }, (_, i) =>
      largeGroupNode(`svc-${i}`, 3, [`svc${i}.example.com`]),
    );
    const edges: Edge[] = []; // fully disconnected components

    const { nodes: laid } = await getLayoutedElements(nodes, edges);
    const boxes = boundingBoxes(laid);
    expect(boxes.length).toBe(nodes.length);

    // No overlaps among the spread components either.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(overlaps(boxes[i], boxes[j])).toBe(false);
      }
    }

    // The bounding box of the whole layout must not be a degenerate single
    // column: assert there is meaningful horizontal spread, i.e. more than one
    // distinct x-band. (A one-column pile would have all x's ~equal.)
    const minX = Math.min(...boxes.map((b) => b.x));
    const maxX = Math.max(...boxes.map((b) => b.x + b.w));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxY = Math.max(...boxes.map((b) => b.y + b.h));
    const width = maxX - minX;
    const height = maxY - minY;

    // Distinct x-origins ⇒ the components did NOT all pile into one column.
    const distinctXBands = new Set(boxes.map((b) => Math.round(b.x / 50))).size;
    expect(distinctXBands).toBeGreaterThan(1);

    // Overall layout is not absurdly tall-and-thin (the #2176 right-column
    // symptom). With 6 equal cards a healthy pack is roughly landscape; require
    // width to be at least a third of height so it can't collapse to a column.
    expect(width).toBeGreaterThan(height / 3);
  });
});
