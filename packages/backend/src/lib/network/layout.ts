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
};

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
    const edgePoints = collectEdgePoints(layoutedGraph);

    const layoutedEdges: Edge[] = edges.map(edge => {
      const points = edgePoints.get(edge.id);
      if (!points || points.length < 2) return edge;
      return { ...edge, data: { ...edge.data, points } };
    });

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
    const elkEdges: ElkExtendedEdge[] = edges.map(edge => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target]
    }));

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