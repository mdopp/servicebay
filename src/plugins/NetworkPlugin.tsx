'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Node, Edge, Position, Connection, Handle, NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { NetworkGraph } from '@/lib/network/types';
import { RefreshCw, X, Trash2, Edit } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useToast } from '@/providers/ToastProvider';
import ExternalLinkModal from '@/components/ExternalLinkModal';
import Link from 'next/link';

const nodeWidth = 172;
const nodeHeight = 150; // Increased from 80 to account for variable content height

interface GroupNodeData {
    label: string;
    subLabel?: string;
    status?: string;
    ports?: number[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rawData?: any;
}

const GroupNode = ({ data }: { data: GroupNodeData }) => {
    const isGateway = data.rawData?.type === 'gateway';
    const statusColor = data.status === 'up' ? 'bg-green-500' : (data.status === 'down' ? 'bg-red-500' : 'bg-gray-400');
    
    return (
      <div className={`w-full h-full min-w-[200px] min-h-[100px] border-2 border-dashed rounded-lg flex flex-col ${isGateway ? 'border-emerald-500 bg-emerald-50/50 dark:border-emerald-500 dark:bg-emerald-900/20' : 'border-gray-400 dark:border-gray-500 bg-gray-50/50 dark:bg-gray-800/50'}`}>
        <Handle type="target" position={Position.Left} className="!bg-gray-400 !w-2 !h-2 !top-1/2" />
        
        {/* Header Area */}
        <div className={`h-[32px] border-b-2 border-dashed flex items-center px-3 gap-2 shrink-0 ${isGateway ? 'border-emerald-500/50 dark:border-emerald-500/50 bg-emerald-100/80 dark:bg-emerald-900/50' : 'border-gray-400/50 dark:border-gray-500/50 bg-gray-200/80 dark:bg-gray-700/50'} rounded-t-md`}>
            <div className={`w-2 h-2 rounded-full ${statusColor}`} />
            <div className="flex flex-col flex-1 min-w-0 justify-center">
                <div className={`text-[10px] font-bold uppercase truncate leading-tight ${isGateway ? 'text-emerald-700 dark:text-emerald-300' : 'text-gray-700 dark:text-gray-300'}`}>{data.label || 'Unknown Group'}</div>
                {data.subLabel && <div className="text-[8px] opacity-70 truncate leading-tight text-gray-600 dark:text-gray-400">{data.subLabel}</div>}
            </div>
            {data.ports && data.ports.length > 0 && (
                <div className="text-[8px] font-mono bg-white/50 dark:bg-black/20 px-1.5 py-0.5 rounded text-gray-600 dark:text-gray-300">
                    :{data.ports.join(', :')}
                </div>
            )}
        </div>

        {/* Body Area - Implicitly fills the rest */}
        <div className="flex-1 relative">
            {/* Content moves here */}
        </div>

        <Handle type="source" position={Position.Right} className="!bg-gray-400 !w-2 !h-2 !top-1/2" />
      </div>
    );
};
  
const nodeTypes = {
    group: GroupNode,
};

const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph({ compound: true });
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  dagreGraph.setGraph({ rankdir: 'LR', ranksep: 100, nodesep: 50 });

  // Safe ID Mapping to prevent Dagre from choking on special characters
  const safeIdMap = new Map<string, string>();
  const reverseIdMap = new Map<string, string>();
  
  nodes.forEach((node, index) => {
      const safeId = `n${index}`;
      safeIdMap.set(node.id, safeId);
      reverseIdMap.set(safeId, node.id);
  });

  const nodeIds = new Set(nodes.map(n => n.id));

  nodes.forEach((node) => {
    const safeId = safeIdMap.get(node.id)!;
    
    if (node.type === 'group') {
        const hasChildren = nodes.some(n => n.parentId === node.id);
        if (!hasChildren) {
             dagreGraph.setNode(safeId, { label: safeId, width: 300, height: 150 });
        } else {
             // Add padding for groups with children
             dagreGraph.setNode(safeId, { 
                 label: safeId,
                 paddingLeft: 40,
                 paddingRight: 40,
                 paddingTop: 80, // Header height (32) + internal padding (48)
                 paddingBottom: 40 // Internal padding (40)
             });
        }
    } else {
        dagreGraph.setNode(safeId, { width: nodeWidth, height: nodeHeight });
    }
    
    if (node.parentId && nodeIds.has(node.parentId)) {
        const safeParentId = safeIdMap.get(node.parentId);
        if (safeParentId) {
            dagreGraph.setParent(safeId, safeParentId);
        }
    }
  });

  // Create a map of node ID to parent ID for quick lookup
  const parentMap = new Map(nodes.map(n => [n.id, n.parentId]));

  // Helper to check if ancestorId is an ancestor of nodeId
  const isAncestor = (ancestorId: string, nodeId: string) => {
      if (ancestorId === nodeId) return true; // Self is ancestor of self in this context check
      let current = nodeId;
      let depth = 0;
      while (current && depth < 100) { // Prevent infinite loops
          const parent = parentMap.get(current);
          if (parent === ancestorId) return true;
          if (!parent) break;
          current = parent;
          depth++;
      }
      return false;
  };

  // Helper to find a representative child node for a group
  // If a group has children, we should connect edges to one of the children instead of the group itself
  // This helps Dagre avoid issues with edges connected to compound nodes
  const getRepresentativeId = (nodeId: string): string => {
      const children = nodes.filter(n => n.parentId === nodeId);
      if (children.length > 0) {
          // Recursively find a leaf node
          return getRepresentativeId(children[0].id);
      }
      return nodeId;
  };

  edges.forEach((edge) => {
    // Ensure both source and target exist in the graph
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        console.warn(`Invalid Edge (Missing Node): ${edge.source} -> ${edge.target}`);
        return;
    }

    // Skip self-loops
    if (edge.source === edge.target) {
        console.warn(`Invalid Edge (Self-loop): ${edge.source} -> ${edge.target}`);
        return;
    }

    // Skip edges that connect a node to its own ancestor or descendant
    // This prevents "compound" cycles that confuse Dagre
    if (isAncestor(edge.source, edge.target) || isAncestor(edge.target, edge.source)) {
        console.warn(`Invalid Edge (Ancestor/Descendant): ${edge.source} -> ${edge.target}`);
        return;
    }

    // Use representative nodes for layout edges
    const sourceRep = getRepresentativeId(edge.source);
    const targetRep = getRepresentativeId(edge.target);

    const safeSource = safeIdMap.get(sourceRep);
    const safeTarget = safeIdMap.get(targetRep);

    if (safeSource && safeTarget) {
        // Avoid self-loops created by representative mapping
        if (safeSource !== safeTarget) {
            dagreGraph.setEdge(safeSource, safeTarget);
        }
    }
  });

  // Debug: Check for disconnected subgraphs or other anomalies
  // Sometimes Dagre fails if the graph is not connected in a specific way?
  // Or if there are edges between nodes in different clusters that cause crossing issues?
  
  try {
    dagre.layout(dagreGraph);
  } catch (error) {
    console.error("Dagre layout failed:", error);
    
    // DEBUG: Dump the graph structure to help identify the issue
    const debugNodes = dagreGraph.nodes().map(n => {
        const node = dagreGraph.node(n);
        const parent = dagreGraph.parent(n);
        return { id: n, parent, ...node };
    });
    const debugEdges = dagreGraph.edges().map(e => ({ v: e.v, w: e.w }));
    
    console.log("--- DAGRE DEBUG INFO ---");
    console.log("Nodes:", JSON.stringify(debugNodes, null, 2));
    console.log("Edges:", JSON.stringify(debugEdges, null, 2));
    console.log("Original Nodes:", JSON.stringify(nodes.map(n => ({ id: n.id, parent: n.parentId, type: n.type })), null, 2));
    console.log("------------------------");

    // Fallback Layout: Simple Grid
    // This ensures the user sees SOMETHING instead of an empty screen
    let x = 0;
    let y = 0;
    const fallbackNodes = nodes.map((node, index) => {
        const isGroup = node.type === 'group';
        const width = isGroup ? 400 : nodeWidth;
        const height = isGroup ? 300 : nodeHeight;
        
        const currentNode = {
            ...node,
            position: { x, y },
            style: isGroup ? { width, height } : undefined
        };

        x += width + 50;
        if ((index + 1) % 5 === 0) {
            x = 0;
            y += 300;
        }
        return currentNode;
    });
    
    return { nodes: fallbackNodes, edges };
  }

  const layoutedNodes = nodes.map((node) => {
    const safeId = safeIdMap.get(node.id);
    const nodeWithPosition = safeId ? dagreGraph.node(safeId) : null;
    
    // Fallback if dagre failed to layout node
    if (!nodeWithPosition) {
        return {
            ...node,
            position: { x: 0, y: 0 }
        };
    }
    
    const width = nodeWithPosition.width || (node.type === 'group' ? 200 : nodeWidth);
    const height = nodeWithPosition.height || (node.type === 'group' ? 100 : nodeHeight);

    let x = nodeWithPosition.x - width / 2;
    let y = nodeWithPosition.y - height / 2;

    if (node.parentId) {
        const safeParentId = safeIdMap.get(node.parentId);
        const parentNode = safeParentId ? dagreGraph.node(safeParentId) : null;
        if (parentNode) {
            const parentWidth = parentNode.width || 200;
            const parentHeight = parentNode.height || 100;
            const parentX = parentNode.x - parentWidth / 2;
            const parentY = parentNode.y - parentHeight / 2;
            
            x = x - parentX;
            y = y - parentY;
        }
    }

    // Ensure no NaNs
    if (isNaN(x)) x = 0;
    if (isNaN(y)) y = 0;

    return {
      ...node,
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
      position: { x, y },
      style: node.type === 'group' ? {
          width: width,
          height: height,
      } : undefined
    };
  });

  return { nodes: layoutedNodes, edges };
};

export default function NetworkPlugin() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [selectedNodeData, setSelectedNodeData] = useState<any>(null);
   
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const { addToast } = useToast();

  // Link Modal State
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkForm, setLinkForm] = useState({ name: '', url: '', description: '', monitor: false });

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/network/graph');
      if (!res.ok) throw new Error('Failed to fetch graph');
      const data: NetworkGraph = await res.json();

      // Transform to React Flow format
      const flowNodes: Node[] = data.nodes.map(n => {
        if (n.type === 'group' || n.type === 'proxy') {
             return {
                id: n.id,
                type: 'group',
                position: { x: 0, y: 0 },
                data: { 
                    label: n.label, 
                    subLabel: n.subLabel,
                    status: n.status,
                    ports: n.ports,
                    rawData: n.rawData 
                },
                parentId: n.parentNode,
                extent: n.extent,
             };
        }

        let className = 'border rounded-xl shadow-sm p-2 ';
        if (n.type === 'internet') className += '!bg-sky-100 dark:!bg-sky-900 !border-sky-200 dark:!border-sky-800 !text-sky-900 dark:!text-sky-100';
        else if (n.type === 'router') className += '!bg-amber-100 dark:!bg-amber-900 !border-amber-200 dark:!border-amber-800 !text-amber-900 dark:!text-amber-100';
        else if (n.type === 'service') className += '!bg-indigo-100 dark:!bg-indigo-900 !border-indigo-200 dark:!border-indigo-800 !text-indigo-900 dark:!text-indigo-100';
        else className += '!bg-white dark:!bg-gray-800 !border-gray-200 dark:!border-gray-700 !text-gray-900 dark:!text-white';

        return {
            id: n.id,
            type: 'default',
            position: { x: 0, y: 0 },
            className,
            parentId: n.parentNode,
            extent: n.extent,
            data: { 
                originalType: n.type,
                rawData: n.rawData,
                label: (
                    <div className="flex flex-col items-center min-w-[150px]">
                        <div className="font-bold text-sm mb-1">{n.label}</div>
                        
                        {/* Sublabel (IP/Image) */}
                        {n.subLabel && (
                            <div className={`text-xs mb-1 truncate max-w-full ${n.type === 'internet' || n.type === 'router' ? '!opacity-100' : '!text-gray-600 dark:!text-gray-300'}`}>
                                {n.subLabel}
                            </div>
                        )}
                        
                        {/* Internal IP for Router */}
                        {n.type === 'router' && n.metadata?.internalIP && (
                            <div className="text-[10px] mb-1 text-amber-800 dark:text-amber-200 font-mono">
                                LAN: {n.metadata.internalIP}
                            </div>
                        )}

                        {/* Ports */}
                        {n.ports && n.ports.length > 0 && (
                            <div className="flex flex-wrap gap-1 justify-center mb-1">
                                {n.ports.slice(0, 3).map(p => (
                                    <span key={p} className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/10 dark:bg-white/20 font-mono">
                                        :{p}
                                    </span>
                                ))}
                                {n.ports.length > 3 && <span className="text-[10px] opacity-70">+{n.ports.length - 3}</span>}
                            </div>
                        )}

                        {/* Source Badge */}
                        {n.metadata?.source && (
                            <div className="text-[9px] uppercase tracking-wider opacity-70 mb-1">
                                via {n.metadata.source}
                            </div>
                        )}

                        {/* Verified Domains */}
                        {n.type === 'internet' && n.metadata?.verifiedDomains && n.metadata.verifiedDomains.length > 0 && (
                            <div className="flex flex-col gap-0.5 mt-1 w-full">
                                {n.metadata.verifiedDomains.map((domain: string) => (
                                    <a 
                                        key={domain}
                                        href={`https://${domain}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[10px] text-center bg-white/50 dark:bg-black/20 px-1.5 py-0.5 rounded hover:bg-white/80 dark:hover:bg-black/40 transition-colors truncate"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {domain}
                                    </a>
                                ))}
                            </div>
                        )}

                        {/* Status & Link */}
                        <div className="flex items-center gap-2 mt-1">
                            <div 
                                className={`w-2.5 h-2.5 rounded-full ${n.status === 'up' ? 'bg-green-500 shadow-[0_0_5px_rgba(34,197,94,0.6)]' : 'bg-red-500'}`} 
                                title={n.status === 'up' ? 'Status: Up' : 'Status: Down'}
                            />
                            
                            {n.metadata?.link && (
                                <a 
                                    href={n.metadata.link} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                    className="text-xs hover:underline flex items-center gap-1 font-medium"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    Open ↗
                                </a>
                            )}
                        </div>
                    </div>
                ) 
            },
            style: { 
                width: nodeWidth,
            }
        };
      });

      const flowEdges: Edge[] = data.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        animated: e.state === 'active',
        type: e.isManual ? 'default' : 'default',
        style: { 
            stroke: e.isManual ? '#8b5cf6' : (e.state === 'active' ? '#22c55e' : '#9ca3af'),
            strokeDasharray: e.isManual ? '5,5' : undefined,
            strokeWidth: 2
        },
        data: { isManual: e.isManual }
      }));

      const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(flowNodes, flowEdges);

      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [setNodes, setEdges]);

  const onConnect = useCallback(async (params: Connection) => {
    if (!params.source || !params.target) return;

    try {
        const res = await fetch('/api/network/edges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: params.source, target: params.target })
        });

        if (!res.ok) throw new Error('Failed to create edge');
        
        addToast('success', 'Connection created');
        fetchGraph();
    } catch {
        addToast('error', 'Failed to create connection');
    }
  }, [addToast, fetchGraph]);

  const handleDeleteEdge = async () => {
    if (!selectedEdge) return;
    
    try {
        const res = await fetch(`/api/network/edges?id=${selectedEdge.id}`, {
            method: 'DELETE'
        });

        if (!res.ok) throw new Error('Failed to delete edge');
        
        addToast('success', 'Connection removed');
        setSelectedEdge(null);
        fetchGraph();
    } catch {
        addToast('error', 'Failed to remove connection');
    }
  };

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const handleSaveLink = async () => {
    if (!linkForm.name || !linkForm.url) {
        addToast('error', 'Name and URL are required');
        return;
    }

    try {
        const res = await fetch(`/api/services/${encodeURIComponent(linkForm.name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: linkForm.url,
                description: linkForm.description,
                monitor: linkForm.monitor,
                type: 'link'
            })
        });

        if (!res.ok) throw new Error('Failed to update link');
        
        addToast('success', 'Link updated successfully');
        setShowLinkModal(false);
        fetchGraph(); // Refresh graph
        
        // Update selected node data if it's the one we just edited
        if (selectedNodeData && selectedNodeData.rawData.name === linkForm.name) {
             setSelectedNodeData({
                 ...selectedNodeData,
                 rawData: {
                     ...selectedNodeData.rawData,
                     url: linkForm.url,
                     description: linkForm.description,
                     monitor: linkForm.monitor
                 }
             });
        }
    } catch (error) {
        console.error('Failed to update link', error);
        addToast('error', 'Failed to update link');
    }
  };

  const handleEditClick = () => {
      if (!selectedNodeData || !selectedNodeData.rawData) return;
      
      const { type, name, url, description, monitor } = selectedNodeData.rawData;
      
      if (type === 'link') {
          setLinkForm({
              name: name,
              url: url || '',
              description: description || '',
              monitor: monitor || false
          });
          setShowLinkModal(true);
      }
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Network Map" showBack={false} helpId="network">
        <button 
            onClick={fetchGraph}
            disabled={loading}
            className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
        >
            <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
        </button>
      </PageHeader>
      
      <div className="flex-1 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 relative flex">
        <div className="flex-1 h-full">
            <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
                setSelectedNodeData(node.data);
                setSelectedEdge(null);
            }}
            onEdgeClick={(_, edge) => {
                setSelectedEdge(edge);
                setSelectedNodeData(null);
            }}
            onPaneClick={() => {
                setSelectedNodeData(null);
                setSelectedEdge(null);
            }}
            fitView
            >
            <Background />
            <Controls className="!bg-white dark:!bg-gray-800 !border-gray-200 dark:!border-gray-700 [&>button]:!border-gray-200 dark:[&>button]:!border-gray-700 [&>button]:!bg-white dark:[&>button]:!bg-gray-800 [&>button:hover]:!bg-gray-50 dark:[&>button:hover]:!bg-gray-700 [&>button>svg]:!fill-gray-900 dark:[&>button>svg]:!fill-gray-100 [&>button>svg>path]:!fill-gray-900 dark:[&>button>svg>path]:!fill-gray-100" />
            <MiniMap 
                className="!bg-white dark:!bg-gray-800 !border-gray-200 dark:!border-gray-700"
                maskColor="rgba(0, 0, 0, 0.1)"
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                nodeColor={(n: any) => {
                    const type = n.data?.originalType;
                    if (type === 'internet') return '#0ea5e9'; // sky-500
                    if (type === 'router') return '#f59e0b'; // amber-500
                    if (type === 'proxy') return '#10b981'; // emerald-500
                    if (type === 'service') return '#6366f1'; // indigo-500
                    if (type === 'container') return '#6b7280'; // gray-500
                    return '#9ca3af'; // gray-400
                }}
            />
            </ReactFlow>
        </div>

        {/* Details Sidebar */}
        {selectedNodeData && selectedNodeData.rawData && (
            <div className="w-96 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 shadow-xl overflow-y-auto p-4 z-10 absolute right-0 top-0 bottom-0 animate-in slide-in-from-right duration-200">
                <div className="flex justify-between items-center mb-4 sticky top-0 bg-white dark:bg-gray-800 pb-2 border-b border-gray-100 dark:border-gray-700">
                    <h3 className="font-bold text-lg">Node Details</h3>
                    <div className="flex items-center gap-2">
                        {(selectedNodeData.rawData.type === 'container' || selectedNodeData.rawData.type === 'service' || selectedNodeData.rawData.type === 'gateway' || selectedNodeData.rawData.type === 'router') && (
                            <Link 
                                href={(selectedNodeData.rawData.type === 'gateway' || selectedNodeData.rawData.type === 'router') ? '/registry?selected=gateway' : `/edit/${selectedNodeData.rawData.name}`}
                                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors text-blue-600 dark:text-blue-400"
                                title={(selectedNodeData.rawData.type === 'gateway' || selectedNodeData.rawData.type === 'router') ? 'Configure Gateway' : 'Edit Service'}
                            >
                                <Edit size={20} />
                            </Link>
                        )}
                        {selectedNodeData.rawData.type === 'link' && (
                            <button 
                                onClick={handleEditClick}
                                className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors text-blue-600 dark:text-blue-400"
                                title="Edit Link"
                            >
                                <Edit size={20} />
                            </button>
                        )}
                        <button 
                            onClick={() => setSelectedNodeData(null)}
                            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
                        >
                            <X size={20} />
                        </button>
                    </div>
                </div>
                <div className="space-y-4">
                    {/* Source Info */}
                    {selectedNodeData.metadata?.source && (
                        <div className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-100 dark:border-blue-800">
                            <div className="text-xs font-bold text-blue-600 dark:text-blue-400 uppercase mb-1">Source</div>
                            <div className="text-sm text-blue-900 dark:text-blue-100">{selectedNodeData.metadata.source}</div>
                        </div>
                    )}
                    {selectedNodeData.rawData.type === 'link' && (
                        <div className="space-y-3">
                            <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                <div className="text-sm text-gray-500 mb-1">URL</div>
                                <a href={selectedNodeData.rawData.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all">
                                    {selectedNodeData.rawData.url}
                                </a>
                            </div>
                            {selectedNodeData.rawData.description && (
                                <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                    <div className="text-sm text-gray-500 mb-1">Description</div>
                                    <div>{selectedNodeData.rawData.description}</div>
                                </div>
                            )}
                            <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                <div className="text-sm text-gray-500 mb-1">Monitoring</div>
                                <div className="flex items-center gap-2">
                                    <div className={`w-2 h-2 rounded-full ${selectedNodeData.rawData.monitor ? 'bg-green-500' : 'bg-gray-300'}`} />
                                    <span>{selectedNodeData.rawData.monitor ? 'Enabled' : 'Disabled'}</span>
                                </div>
                            </div>
                        </div>
                    )}

                    {selectedNodeData.rawData.type === 'device' && (
                        <div className="space-y-3">
                            <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                <div className="text-sm text-gray-500 mb-1">IP Address</div>
                                <div className="font-mono">{selectedNodeData.rawData.ip}</div>
                            </div>
                            {selectedNodeData.rawData.description && (
                                <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                    <div className="text-sm text-gray-500 mb-1">Description</div>
                                    <div>{selectedNodeData.rawData.description}</div>
                                </div>
                            )}
                        </div>
                    )}

                    {selectedNodeData.rawData.type === 'router' && (
                        <div className="space-y-3">
                            <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                <div className="text-sm text-gray-500 mb-1">Status</div>
                                <div className="flex items-center gap-2">
                                    <div className={`w-2 h-2 rounded-full ${selectedNodeData.rawData.connected ? 'bg-green-500' : 'bg-red-500'}`} />
                                    <span>{selectedNodeData.rawData.connected ? 'Connected' : 'Disconnected'}</span>
                                </div>
                            </div>
                            <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                <div className="text-sm text-gray-500 mb-1">External IP</div>
                                <div className="font-mono">{selectedNodeData.rawData.externalIP || 'Unknown'}</div>
                            </div>
                            <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                <div className="text-sm text-gray-500 mb-1">Internal IP</div>
                                <div className="font-mono">{selectedNodeData.rawData.internalIP || 'Unknown'}</div>
                            </div>
                            {selectedNodeData.rawData.uptime && (
                                <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                    <div className="text-sm text-gray-500 mb-1">Uptime</div>
                                    <div className="font-mono">{Math.floor(selectedNodeData.rawData.uptime / 3600)}h {Math.floor((selectedNodeData.rawData.uptime % 3600) / 60)}m</div>
                                </div>
                            )}
                        </div>
                    )}

                    {(selectedNodeData.rawData.type === 'container' || selectedNodeData.rawData.type === 'service' || selectedNodeData.rawData.type === 'gateway') && (
                        <div className="space-y-3">
                            <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                <div className="text-sm text-gray-500 mb-1">Status</div>
                                <div className="flex items-center gap-2">
                                    <div className={`w-2 h-2 rounded-full ${selectedNodeData.rawData.State === 'running' || selectedNodeData.rawData.active ? 'bg-green-500' : 'bg-red-500'}`} />
                                    <span className="capitalize">{selectedNodeData.rawData.State || (selectedNodeData.rawData.active ? 'active' : 'inactive')}</span>
                                </div>
                            </div>
                            
                            {selectedNodeData.rawData.Image && (
                                <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                    <div className="text-sm text-gray-500 mb-1">Image</div>
                                    <div className="break-all font-mono text-xs">{selectedNodeData.rawData.Image}</div>
                                </div>
                            )}

                            {selectedNodeData.rawData.Ports && selectedNodeData.rawData.Ports.length > 0 && (
                                <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                    <div className="text-sm text-gray-500 mb-1">Ports</div>
                                    <div className="space-y-1">
                                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                                        {selectedNodeData.rawData.Ports.map((p: any, i: number) => (
                                            <div key={i} className="text-xs font-mono">
                                                {(p.HostPort || p.host_port) ? `${p.HostPort || p.host_port} -> ` : ''}{p.ContainerPort || p.container_port}/{p.Protocol || p.protocol || 'tcp'}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {selectedNodeData.rawData.ports && selectedNodeData.rawData.ports.length > 0 && (
                                <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                                    <div className="text-sm text-gray-500 mb-1">Ports</div>
                                    <div className="space-y-1">
                                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                                        {selectedNodeData.rawData.ports.map((p: any, i: number) => (
                                            <div key={i} className="text-xs font-mono">
                                                {p.host ? `${p.host} -> ` : ''}{p.container}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <div>
                        <h4 className="text-xs font-semibold uppercase text-gray-500 mb-2">Raw Data</h4>
                        <pre className="text-xs overflow-x-auto bg-gray-50 dark:bg-gray-900 p-3 rounded-lg border border-gray-200 dark:border-gray-700 font-mono text-gray-700 dark:text-gray-300">
                            {JSON.stringify(selectedNodeData.rawData, null, 2)}
                        </pre>
                    </div>
                </div>
            </div>
        )}

        {/* Edge Details Sidebar */}
        {selectedEdge && (
            <div className="w-80 bg-white dark:bg-gray-800 border-l border-gray-200 dark:border-gray-700 shadow-xl p-4 z-10 absolute right-0 top-0 bottom-0 animate-in slide-in-from-right duration-200">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-lg">Connection</h3>
                    <button 
                        onClick={() => setSelectedEdge(null)}
                        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
                    >
                        <X size={20} />
                    </button>
                </div>
                
                <div className="space-y-4">
                    <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700">
                        <div className="text-sm text-gray-500 mb-1">Type</div>
                        <div className="font-medium">
                            {selectedEdge.data?.isManual ? 'Manual Connection' : 'Auto-detected'}
                        </div>
                    </div>

                    {!!selectedEdge.data?.isManual && (
                        <button
                            onClick={handleDeleteEdge}
                            className="w-full py-2 px-4 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg border border-red-200 transition-colors flex items-center justify-center gap-2"
                        >
                            <Trash2 size={16} />
                            Remove Connection
                        </button>
                    )}
                    
                    {!selectedEdge.data?.isManual && (
                        <div className="text-xs text-gray-500 italic text-center">
                            Auto-detected connections cannot be removed manually.
                        </div>
                    )}
                </div>
            </div>
        )}

        {/* Link Modal */}
        <ExternalLinkModal 
            isOpen={showLinkModal}
            onClose={() => setShowLinkModal(false)}
            onSave={handleSaveLink}
            isEditing={true}
            form={linkForm}
            setForm={setLinkForm}
        />
      </div>
    </div>
  );
}
