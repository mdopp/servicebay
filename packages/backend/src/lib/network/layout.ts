import { Node, Edge, Position } from '@xyflow/react';
import ELK, { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import { logger } from '../logger';

const elk = new ELK();

const GROUP_NODE_TYPES = new Set(['group', 'proxy', 'service', 'pod', 'unmanaged-service']);

// ELK options for layout
const layoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT', // Horizontal flow (Internet -> Router -> Proxy -> Services)
  'elk.spacing.nodeNode': '100', // Vertical spacing between nodes
  'elk.layered.spacing.nodeNodeBetweenLayers': '350', // Horizontal spacing between layers
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN', // Crucial for nesting
  'elk.padding': '[top=50,left=50,bottom=50,right=50]', // Padding for groups
  // #1782 — orthogonal edge routing ("circuit-board" look). The
  // computed bend points are read back from edge.sections and rendered
  // verbatim by the frontend custom edge instead of smoothstep.
  'elk.edgeRouting': 'ORTHOGONAL',
  // Crossing minimization tuning — BRANDES_KOEPF straightens trunks and
  // higher thoroughness reduces crossings so the orthogonal routes stay
  // readable. Extra edge/edge + edge/node spacing keeps parallel runs apart.
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.thoroughness': '20',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.spacing.edgeEdge': '20',
  'elk.spacing.edgeNode': '30',
  // #1783 — place a per-edge port label (e.g. `:2283`) at the centre of each
  // edge and reserve space for it so chips never overlap the routed lines.
  'elk.edgeLabels.placement': 'CENTER',
  'elk.spacing.edgeLabel': '8',
};

// #1783 — approximate the pixel box a monospace port chip occupies so ELK
// reserves overlap-free space for it. ~6.4px/char at the 10px font the chip
// renders in, plus padding for the rounded badge.
function portLabelDimensions(text: string): { width: number; height: number } {
  return { width: text.length * 6.4 + 10, height: 15 };
}

// #1783 — resolve the chip text ELK should reserve space for. Prefer the
// React Flow `label` the frontend already decorated; otherwise synthesise
// `:${port}` from edge data so an unlabelled-but-ported edge still reserves
// room. Returns undefined when there is nothing to show.
function edgeLabelText(edge: Edge): string | undefined {
  if (typeof edge.label === 'string' && edge.label.length > 0) return edge.label;
  const port = (edge.data as { port?: unknown } | undefined)?.port;
  if (typeof port === 'number' && Number.isFinite(port) && port > 0) return `:${port}`;
  return undefined;
}

// #1783 — map a React Flow edge to an ELK edge, attaching a CENTER-placed
// port-label box (sized so ELK reserves overlap-free space) when there is
// chip text to show.
function toElkEdge(edge: Edge): ElkExtendedEdge {
  const labelText = edgeLabelText(edge);
  return {
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
    ...(labelText
      ? { labels: [{ text: labelText, ...portLabelDimensions(labelText) }] }
      : {}),
  };
}

export const getLayoutedElements = async (nodes: Node[], edges: Edge[]) => {
  // We need to restructure the flat list of nodes into a hierarchy for ELK
  const hierarchy = buildHierarchy(nodes, edges);

  try {
    const layoutedGraph = await elk.layout(hierarchy);
    
    const layoutedNodes: Node[] = [];
    
    // Flatten the hierarchy back to React Flow nodes
    const flatten = (node: ElkNode) => {
      if (node.id !== 'root') {
        const original = nodes.find(n => n.id === node.id);
        if (original) {
            layoutedNodes.push({
                ...original,
                position: { x: node.x!, y: node.y! },
                // We do NOT set height here for leaf nodes, so the node can grow with content (CSS h-auto)
                // But for groups, we MUST set the height calculated by ELK to contain children.
                style: { 
                    ...original.style, 
                    width: node.width,
                    height: (GROUP_NODE_TYPES.has(original.data?.type as string)) ? node.height : undefined
                }
            });
        }
      }
      
      node.children?.forEach(child => flatten(child));
    };

    flatten(layoutedGraph);

    // #1782 — collect ELK's orthogonal routing points per edge so the
    // frontend custom edge can draw a 90° polyline instead of smoothstep.
    // All edges are declared at the root graph (see buildHierarchy), so the
    // section coordinates ELK returns are in the root's absolute coordinate
    // space — the same space React Flow node positions live in. We still
    // collect any nested edges (sections relative to a parent) and offset
    // them by the parent's absolute origin so compound graphs keep working.
    const layoutedEdges = attachEdgeLayout(edges, layoutedGraph);

    // Post-processing: Handle Self-Loops
    // Default: Target Left, Source Right
    // Exception: If a node has a self-loop, move Target to Bottom to allow a clean loop (Right -> Bottom)
    layoutedNodes.forEach(node => {
        const hasSelfLoop = edges.some(e => e.source === node.id && e.target === node.id);
        
        const targetHandle = hasSelfLoop ? Position.Bottom : Position.Left;
        const sourceHandle = Position.Right;

        // Update Node Data for Custom Component
        node.data = {
            ...node.data,
            targetHandlePosition: targetHandle,
            sourceHandlePosition: sourceHandle
        };
        
        // Update Node Property for React Flow Edge Routing
        node.targetPosition = targetHandle;
        node.sourcePosition = sourceHandle;

        // Reverse proxy nodes should always connect from center left/right for readability
        if (node.data?.type === 'proxy') {
            node.data.targetHandlePosition = Position.Left;
            node.data.sourceHandlePosition = Position.Right;
            node.targetPosition = Position.Left;
            node.sourcePosition = Position.Right;
        }
    });

    return { nodes: layoutedNodes, edges: layoutedEdges };
  } catch (error) {
    logger.error('layout', 'ELK Layout Error:', error);
    return { nodes, edges };
  }
};

type Point = { x: number; y: number };

/**
 * Read ELK's per-edge layout results back onto the React Flow edges:
 *  - #1782 orthogonal routing points (`data.points`)
 *  - #1783 CENTER-placed port-label position (`data.lpos`)
 *  - #1784 line-hop points on crossing horizontal runs (`data.hops`)
 * All live in the root-absolute coordinate space. Edges ELK produced
 * none of these for are returned untouched.
 */
function attachEdgeLayout(edges: Edge[], layoutedGraph: ElkNode): Edge[] {
  const edgePoints = collectEdgePoints(layoutedGraph);
  const edgeLabelPos = collectEdgeLabelPositions(layoutedGraph);

  // #1784 — compute line-hops from the routed polylines of all edges so a
  // crossing reads as a wire-hop (∩) rather than a junction.
  const hopsByEdge = computeEdgeHops(edgePoints);

  return edges.map(edge => {
    const points = edgePoints.get(edge.id);
    const lpos = edgeLabelPos.get(edge.id);
    const hops = hopsByEdge.get(edge.id);
    if ((!points || points.length < 2) && !lpos) return edge;
    return {
      ...edge,
      data: {
        ...edge.data,
        ...(points && points.length >= 2 ? { points } : {}),
        ...(lpos ? { lpos } : {}),
        ...(hops && hops.length > 0 ? { hops } : {}),
      },
    };
  });
}

/** A single straight segment of a routed edge, tagged with its owning edge. */
type Segment = { edgeId: string; x1: number; y1: number; x2: number; y2: number };

/**
 * #1784 — small slack (px) so a segment that ends *exactly* on another edge's
 * run (a shared corner / T-junction) is excluded, while a genuine crossing
 * that overshoots by a pixel of rounding still registers.
 */
const HOP_MARGIN = 1.5;

/** Minimum gap from a segment endpoint before a crossing counts as a hop, so
 *  hops never land on a corner/terminal and produce a malformed arc. */
const HOP_ENDPOINT_GUARD = 3;

const isHorizontal = (s: Segment) => Math.abs(s.y1 - s.y2) <= HOP_MARGIN;
const isVertical = (s: Segment) => Math.abs(s.x1 - s.x2) <= HOP_MARGIN;

/** Break each edge's polyline into its straight segments. */
function toSegments(edgeId: string, points: Point[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    out.push({
      edgeId,
      x1: points[i].x,
      y1: points[i].y,
      x2: points[i + 1].x,
      y2: points[i + 1].y,
    });
  }
  return out;
}

/**
 * #1784 — find the point where a horizontal segment crosses a vertical segment
 * of a *different* edge, or null when they don't genuinely cross.
 *
 * A genuine crossing requires the vertical's x to fall strictly inside the
 * horizontal's x-range and the horizontal's y strictly inside the vertical's
 * y-range, each by more than `HOP_ENDPOINT_GUARD`. That guard rejects shared
 * endpoints and T-junctions (where one segment merely *touches* the other's
 * line) — only true overpasses get a hop.
 */
export function segmentCrossing(h: Segment, v: Segment): Point | null {
  if (h.edgeId === v.edgeId) return null;
  const hx1 = Math.min(h.x1, h.x2);
  const hx2 = Math.max(h.x1, h.x2);
  const vy1 = Math.min(v.y1, v.y2);
  const vy2 = Math.max(v.y1, v.y2);
  const x = (v.x1 + v.x2) / 2; // vertical's x
  const y = (h.y1 + h.y2) / 2; // horizontal's y

  const xInside = x > hx1 + HOP_ENDPOINT_GUARD && x < hx2 - HOP_ENDPOINT_GUARD;
  const yInside = y > vy1 + HOP_ENDPOINT_GUARD && y < vy2 - HOP_ENDPOINT_GUARD;
  if (!xInside || !yInside) return null;
  return { x, y };
}

/**
 * #1784 — for every edge, the ordered list of hop points where one of its
 * horizontal runs crosses a vertical run of a different edge. Hops are placed
 * on the *horizontal* segment (it gets the ∩ bump); the vertical edge passes
 * straight. Sorted left→right so the frontend inserts them in path order.
 */
export function computeEdgeHops(edgePoints: Map<string, Point[]>): Map<string, Point[]> {
  const segments: Segment[] = [];
  for (const [edgeId, points] of edgePoints) {
    if (points.length >= 2) segments.push(...toSegments(edgeId, points));
  }
  const horizontals = segments.filter(isHorizontal);
  const verticals = segments.filter(isVertical);

  const result = new Map<string, Point[]>();
  for (const h of horizontals) {
    const hops: Point[] = [];
    for (const v of verticals) {
      const cross = segmentCrossing(h, v);
      if (cross) hops.push(cross);
    }
    if (hops.length === 0) continue;
    hops.sort((a, b) => a.x - b.x);
    const existing = result.get(h.edgeId) ?? [];
    result.set(h.edgeId, [...existing, ...hops]);
  }
  // Keep each edge's combined hop list sorted left→right across all its runs.
  for (const [edgeId, hops] of result) {
    hops.sort((a, b) => a.x - b.x);
    result.set(edgeId, hops);
  }
  return result;
}

/**
 * #1782 — walk the laid-out ELK tree and return, per edge id, the ordered
 * list of absolute points (startPoint → bendPoints → endPoint) of its first
 * routing section.
 *
 * ELK reports an edge's section coordinates relative to the coordinate system
 * of the node the edge is *declared* in. We declare every edge at the root, so
 * its sections are already root-absolute. We still accumulate the absolute
 * origin (`offsetX/offsetY`) of each container as we descend so that any edge
 * declared inside a compound node would be offset correctly — keeping nested
 * (compound) graphs robust rather than mis-placing intra-group routes.
 */
function collectEdgePoints(graph: ElkNode): Map<string, Point[]> {
  const result = new Map<string, Point[]>();

  const walk = (node: ElkNode, offsetX: number, offsetY: number) => {
    node.edges?.forEach(edge => {
      const section = edge.sections?.[0];
      if (!section) return;
      const raw = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ];
      result.set(
        edge.id,
        raw.map(p => ({ x: p.x + offsetX, y: p.y + offsetY })),
      );
    });

    node.children?.forEach(child => {
      // Children positions are relative to this node; a child's absolute
      // origin is this node's absolute origin plus the child's local x/y.
      walk(child, offsetX + (child.x ?? 0), offsetY + (child.y ?? 0));
    });
  };

  // Root has no positional offset of its own.
  walk(graph, 0, 0);
  return result;
}

/**
 * #1783 — walk the laid-out ELK tree and return, per edge id, the absolute
 * CENTER of its first edge label. ELK reports a label's x/y as the top-left
 * of the label box in the coordinate system of the edge's declaring node, so
 * we add half the box size to get the centre and apply the same parent-origin
 * offsetting as collectEdgePoints for nested (compound) edges.
 */
function collectEdgeLabelPositions(graph: ElkNode): Map<string, Point> {
  const result = new Map<string, Point>();

  const walk = (node: ElkNode, offsetX: number, offsetY: number) => {
    node.edges?.forEach(edge => {
      const label = edge.labels?.[0];
      if (!label || label.x === undefined || label.y === undefined) return;
      result.set(edge.id, {
        x: label.x + (label.width ?? 0) / 2 + offsetX,
        y: label.y + (label.height ?? 0) / 2 + offsetY,
      });
    });

    node.children?.forEach(child => {
      walk(child, offsetX + (child.x ?? 0), offsetY + (child.y ?? 0));
    });
  };

  walk(graph, 0, 0);
  return result;
}

function buildHierarchy(nodes: Node[], edges: Edge[]): ElkNode {
    const nodeMap = new Map<string, ElkNode>();
    const rootChildren: ElkNode[] = [];

    // 1. Create ElkNodes
    nodes.forEach(node => {
        const isGroup = GROUP_NODE_TYPES.has(node.data.type as string);

        nodeMap.set(node.id, {
            id: node.id,
            // Initialize with a default size. 
            // If it becomes a parent (has children), we will remove width/height later to let ELK calculate it.
            width: node.measured?.width ?? calculateNodeWidth(node),
            height: node.measured?.height ?? calculateNodeHeight(node),
            layoutOptions: isGroup ? { 
                'elk.padding': '[top=80,left=50,bottom=50,right=50]',
                'elk.direction': 'RIGHT', // Horizontal layout for contents (Containers side-by-side)
                'elk.algorithm': 'layered', 
                'elk.resize': 'true',
                'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
                'elk.spacing.nodeNode': '80', 
                'elk.layered.spacing.nodeNodeBetweenLayers': '120',
            } : undefined,
            labels: [{ text: (node.data.label as string) || '' }],
            children: []
        });
    });

    // 2. Build Tree
    nodes.forEach(node => {
        const elkNode = nodeMap.get(node.id)!;
        if (node.parentId) {
            const parent = nodeMap.get(node.parentId);
            if (parent) {
                parent.children!.push(elkNode);
                // Parent is a compound node now, remove fixed dimensions to allow auto-sizing
                delete parent.width;
                delete parent.height;
            } else {
                rootChildren.push(elkNode);
            }
        } else {
            rootChildren.push(elkNode);
        }
    });

    // 3. Add Edges
    // ELK edges need to be placed at the correct level of hierarchy (LCA - Lowest Common Ancestor)
    // For simplicity, we can often put them at the root, but for compound graphs, 
    // edges between children of the same parent should ideally be in that parent.
    // However, putting them at root usually works for basic layout.
    const elkEdges: ElkExtendedEdge[] = edges.map(toElkEdge);

    return {
        id: 'root',
        layoutOptions: layoutOptions,
        children: rootChildren,
        edges: elkEdges
    };
}

/** Detail-grid row count per node kind, mirroring NetworkDashboard.tsx. Split
 *  out of calculateNodeHeight to keep that function under the complexity
 *  budget. */
function countDetailRows(
    type: unknown,
    raw: Record<string, unknown>,
    metadata: Record<string, unknown>,
): number {
    if (type === 'container') {
        // Created, Status (1 row) + Network (optional)
        return raw.hostNetwork ? 2 : 1;
    }
    if (type === 'service' || type === 'unmanaged-service') {
        // State, Load (1 row) + Network (optional)
        return raw.hostNetwork ? 2 : 1;
    }
    if (type === 'link') {
        // URL (Full width -> 1 row)
        return 1;
    }
    if (type === 'router') {
        // Ext IP, Int IP (1 row) + Uptime (1 row) + DNS (optional 1 row)
        const dnsServers = metadata.dnsServers;
        return Array.isArray(dnsServers) && dnsServers.length > 0 ? 3 : 2;
    }
    return 0;
}

function calculateNodeHeight(node: Node): number | undefined {
    if (node.data.type === 'group') return 320;
    if (node.data.type === 'internet') return 150;
    
    // Base Header (Title + Status + Padding)
    let height = 60; 
    const data = node.data || {};
    
    // SubLabel (IP or Image) - ~28px
    if (data.subLabel) height += 28;
    
    // Details Grid — replicates the row count from NetworkDashboard.tsx.
    // #969 — rawData / metadata carry per-node-kind discriminated shapes
    // (container / service / router / link). Type as Record<string, unknown>;
    // every field access narrows at the call site with a typeof / truthiness
    // check, so we don't need (and don't have) a discriminated union here.
    const raw = (data.rawData as Record<string, unknown> | undefined) ?? {};
    const metadata = (data.metadata as Record<string, unknown> | undefined) ?? {};

    // Each detail row is approx 40px (label + value + gap)
    height += countDetailRows(node.data.type, raw, metadata) * 40;

    // Verified Domains (Nginx / Router)
    const domains = Array.isArray(metadata.verifiedDomains) ? metadata.verifiedDomains as string[] : undefined;
    if (domains && domains.length > 0) {
        height += 25; // Header "Verified Domains"
        height += domains.length * 36; // Each domain row approximation
        height += 10; // Padding
    }

    // Hostname Field
    if (data.hostname) height += 28;

    // Description (line-clamp-2 -> max ~36px)
    if (metadata.description && node.data.type !== 'link') height += 40;
    
    // Footer (Ports)
    const ports = (data.ports as string[]) || [];
    if (ports.length > 0) {
        height += 15; // Top border/padding
        // Badges wrap. Assume ~3 badges per row for standard width (340px)
        // Each badge is approx 24px high + gap
        const rows = Math.ceil(ports.length / 3);
        height += rows * 20;
    }
    
    // Bottom Padding
    height += 20;
    
    return Math.max(height, 240); // Ensure minimum height
}

function calculateNodeWidth(node: Node): number {
    if (node.data.type === 'group') return 440; 
    if (node.data.type === 'internet') return 150;

    let width = 440; // Base width Increased for 3 ports in a row
    const data = node.data || {};

    // Check for long strings that might expand the card
    // Approx 8px per character for standard font
    
    // Title
    if (data.label && (data.label as string).length > 35) {
        width = Math.max(width, (data.label as string).length * 9 + 40);
    }

    // Hostname
    if (data.hostname && (data.hostname as string).length > 40) {
        width = Math.max(width, (data.hostname as string).length * 8 + 40);
    }

    // Verified Domains
    const metadata = (data.metadata as Record<string, unknown> | undefined) ?? {};
    const domains = Array.isArray(metadata.verifiedDomains) ? metadata.verifiedDomains as string[] : undefined;
    if (domains && domains.length > 0) {
        const maxDomainLen = Math.max(...domains.map(d => d.length));
        if (maxDomainLen > 40) {
            width = Math.max(width, maxDomainLen * 8 + 40);
        }
    }

    return Math.min(width, 600); // Cap at 600px
}