import { Node, Edge, Position } from '@xyflow/react';
import ELK, { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

// ELK options for layout
const layoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT', // Horizontal flow (Internet -> Router -> Proxy -> Services)
  'elk.spacing.nodeNode': '100', // Vertical spacing between nodes
  'elk.layered.spacing.nodeNodeBetweenLayers': '350', // Horizontal spacing between layers
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN', // Crucial for nesting
  'elk.padding': '[top=50,left=50,bottom=50,right=50]', // Padding for groups
  // Optimization for cleaner lines
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX', // Better centering of parents relative to children
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
                    height: (['group', 'proxy', 'service', 'pod'].includes(original.data?.type as string)) ? node.height : undefined
                }
            });
        }
      }
      
      node.children?.forEach(child => flatten(child));
    };

    flatten(layoutedGraph);

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
    });

    return { nodes: layoutedNodes, edges };
  } catch (error) {
    console.error('ELK Layout Error:', error);
    return { nodes, edges };
  }
};

function buildHierarchy(nodes: Node[], edges: Edge[]): ElkNode {
    const nodeMap = new Map<string, ElkNode>();
    const rootChildren: ElkNode[] = [];

    // 1. Create ElkNodes
    nodes.forEach(node => {
        const isGroup = ['group', 'proxy', 'service', 'pod'].includes(node.data.type as string);

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

function calculateNodeHeight(node: Node): number | undefined {
    if (node.data.type === 'group') return undefined;
    if (node.data.type === 'internet') return 150;
    
    // Base Header (Title + Status + Padding)
    let height = 60; 
    const data = node.data || {};
    
    // SubLabel (IP or Image) - ~28px
    if (data.subLabel) height += 28;
    
    // Details Grid
    // We need to replicate the logic from NetworkPlugin.tsx to count rows
    let detailRows = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (data.rawData as any) || {};
    
    if (node.data.type === 'container') {
        // Created, Status (1 row) + Network (optional)
        detailRows = 1;
        if (raw.hostNetwork) detailRows += 1;
    } else if (node.data.type === 'service') {
        // State, Load (1 row) + Network (optional)
        detailRows = 1;
        if (raw.hostNetwork) detailRows += 1;
    } else if (node.data.type === 'link') {
        // URL (Full width -> 1 row)
        detailRows = 1;
    } else if (node.data.type === 'router') {
        // Ext IP, Int IP (1 row) + Uptime (1 row) + DNS (optional 1 row)
        detailRows = 2;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((data.metadata as any)?.dnsServers && (data.metadata as any).dnsServers.length > 0) detailRows += 1;
    }
    
    // Each detail row is approx 40px (label + value + gap)
    height += detailRows * 40;

    // Verified Domains (Nginx / Router)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const domains = (data.metadata as any)?.verifiedDomains as string[];
    if (domains && domains.length > 0) {
        height += 25; // Header "Verified Domains"
        height += domains.length * 80; // Each domain row
        height += 10; // Padding
    }

    // Hostname Field
    if (data.hostname) height += 28;

    // Description (line-clamp-2 -> max ~36px)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((data.metadata as any)?.description && node.data.type !== 'link') height += 40;
    
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const domains = (data.metadata as any)?.verifiedDomains as string[];
    if (domains && domains.length > 0) {
        const maxDomainLen = Math.max(...domains.map(d => d.length));
        if (maxDomainLen > 40) {
            width = Math.max(width, maxDomainLen * 8 + 40);
        }
    }

    return Math.min(width, 600); // Cap at 600px
}