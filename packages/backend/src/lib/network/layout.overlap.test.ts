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

/** A leaf container card that declares `parentId` so it nests inside a group. */
function containerNode(id: string, parentId: string): Node {
  return {
    id,
    parentId,
    position: { x: 0, y: 0 },
    data: {
      type: 'container',
      label: id,
      status: 'up',
      subLabel: `image/${id}:latest`,
      rawData: { type: 'container', status: 'running', created: '2026-01-01' },
    },
  } as unknown as Node;
}

/** An expanded (NOT collapsed) service group that owns `childIds` containers. */
function serviceGroupWithChildren(id: string): Node {
  return {
    id,
    position: { x: 0, y: 0 },
    data: {
      type: 'service',
      label: id,
      status: 'up',
      rawData: { type: 'service', active: true, load: '0.1' },
    },
  } as unknown as Node;
}

describe('getLayoutedElements — nested group grows around children (#2191 criterion 1+3)', () => {
  it('grows a multi-container service to enclose its children AND fans out disconnected components in the SAME graph', async () => {
    // The #2191 HARD case: one expanded service that OWNS 4 containers (must
    // grow to enclose them, zero child-child overlap) PLUS several disconnected
    // top-level components (must still fan out, not stack into one column) — in
    // ONE layout. Pre-#2191 the `hasNesting` gate turned INCLUDE_CHILDREN on
    // globally, which broke the fan-out; or off, which stacked the containers.
    const svc = serviceGroupWithChildren('big-service');
    const containers = ['c-alpha', 'c-beta', 'c-gamma', 'c-delta'].map((c) =>
      containerNode(c, 'big-service'),
    );
    // Disconnected top-level floaters (the #2175/#2176 shape) in the same graph.
    const floaters = Array.from({ length: 5 }, (_, i) =>
      largeGroupNode(`float-${i}`, 3, [`float${i}.example.com`]),
    );

    const nodes: Node[] = [svc, ...containers, ...floaters];
    const edges: Edge[] = []; // service↔container nesting needs no edges; floaters disconnected

    const { nodes: laid } = await getLayoutedElements(nodes, edges);

    // --- Criterion 1: the service group bbox encloses ALL its children,
    //     children laid out inside it with zero child-child overlap. ---
    const parent = laid.find((n) => n.id === 'big-service')!;
    expect(parent).toBeDefined();
    const pw = (parent.style?.width as number | undefined) ?? 0;
    const ph = (parent.style?.height as number | undefined) ?? 0;
    // The group must have grown well beyond the ~240px leaf init guess.
    expect(ph).toBeGreaterThan(300);
    expect(pw).toBeGreaterThan(300);

    // Child positions are LOCAL to the parent (React Flow parent/extent);
    // absolute = parent.position + child.position. The child must sit inside
    // the parent's box.
    const kids = laid.filter((n) => n.parentId === 'big-service');
    expect(kids.length).toBe(containers.length);
    const kidRects: Rect[] = kids.map((k) => ({
      x: k.position.x,
      y: k.position.y,
      w: (k.style?.width as number | undefined) ?? 440,
      h: (k.style?.height as number | undefined) ?? 240,
    }));
    for (const r of kidRects) {
      // Enclosed within the parent's LOCAL coordinate box [0,0,pw,ph].
      expect(r.x).toBeGreaterThanOrEqual(-1);
      expect(r.y).toBeGreaterThanOrEqual(-1);
      expect(r.x + r.w).toBeLessThanOrEqual(pw + 1);
      expect(r.y + r.h).toBeLessThanOrEqual(ph + 1);
    }
    // Zero child-child overlap.
    for (let i = 0; i < kidRects.length; i++) {
      for (let j = i + 1; j < kidRects.length; j++) {
        expect(
          overlaps(kidRects[i], kidRects[j]),
          `children ${kids[i].id} and ${kids[j].id} overlap`,
        ).toBe(false);
      }
    }

    // --- Criterion 2 (in the same graph): top-level components don't overlap
    //     and use the canvas (fan-out preserved). ---
    const topBoxes = boundingBoxes(laid); // parentless only
    for (let i = 0; i < topBoxes.length; i++) {
      for (let j = i + 1; j < topBoxes.length; j++) {
        expect(
          overlaps(topBoxes[i], topBoxes[j]),
          `top-level ${i} and ${j} overlap`,
        ).toBe(false);
      }
    }
    // Floaters + the grown service fan out into more than one x-band.
    const distinctXBands = new Set(topBoxes.map((b) => Math.round(b.x / 50))).size;
    expect(distinctXBands).toBeGreaterThan(1);
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
