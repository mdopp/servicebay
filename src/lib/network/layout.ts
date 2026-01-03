import { Node, Edge } from '@xyflow/react';
import ELK, { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

// ELK options for layout
const layoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.spacing.nodeNode': '80',
  'elk.layered.spacing.nodeNodeBetweenLayers': '100',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN', // Crucial for nesting
  'elk.padding': '[top=50,left=50,bottom=50,right=50]', // Padding for groups
};

export const getLayoutedElements = async (nodes: Node[], edges: Edge[]) => {
  // We need to restructure the flat list of nodes into a hierarchy for ELK
  const hierarchy = buildHierarchy(nodes, edges);

  try {
    const layoutedGraph = await elk.layout(hierarchy);
    
    const layoutedNodes: Node[] = [];
    
    // Flatten the hierarchy back to React Flow nodes
    const flatten = (node: ElkNode, _parentId?: string) => {
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
      
      node.children?.forEach(child => flatten(child, node.id));
    };

    flatten(layoutedGraph);
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
        const isInternet = node.data.type === 'internet';
         
        const isGroup = ['group', 'proxy', 'service', 'pod'].includes(node.data.type as string);

        nodeMap.set(node.id, {
            id: node.id,
            // Initialize with a default size. 
            // If it becomes a parent (has children), we will remove width/height later to let ELK calculate it.
            width: node.measured?.width ?? (isInternet ? 150 : 340),
            height: node.measured?.height ?? calculateNodeHeight(node),
            layoutOptions: isGroup ? { 
                'elk.padding': '[top=100,left=50,bottom=50,right=50]',
                'elk.direction': 'RIGHT',
                'elk.resize': 'true' // Explicitly allow resizing
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
    if (node.type === 'group') return undefined;
    if (node.data.type === 'internet') return 150;
    
    let height = 90; // Base header + padding
    const data = node.data || {};
    
    // SubLabel (IP or Image)
    if (data.subLabel) height += 30;
    
    // Details Section
    if (node.type === 'container') height += 60; // Created + Status
    else if (node.type === 'service') height += 30; // State + Load
    else if (node.type === 'link') height += 30; // URL
    else if (node.type === 'router') height += 60; // IPs + Uptime
    // Device has no details anymore (IP in subLabel, Description hidden)
    
    // Description
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((data.metadata as any)?.description) height += 40;
    
    // Ports
     
    const ports = (data.ports as string[]) || [];
    if (ports.length > 0) {
        // Approx 4 ports per row
        const rows = Math.ceil(ports.length / 4);
        height += rows * 30 + 10;
    }
    
    // Extra buffer for footer/spacing
    height += 20;
    
    return Math.max(height, 220); // Ensure minimum height
}