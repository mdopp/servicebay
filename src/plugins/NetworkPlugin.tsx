'use client';

import { useState, useEffect, useCallback } from 'react';
import { ReactFlow, Background, Controls, MiniMap, useNodesState, useEdgesState, Node, Edge, Position, Connection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from 'dagre';
import { NetworkGraph } from '@/lib/network/types';
import { RefreshCw, X, Trash2 } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useToast } from '@/providers/ToastProvider';

const nodeWidth = 172;
const nodeHeight = 80;

const getLayoutedElements = (nodes: Node[], edges: Edge[]) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));

  dagreGraph.setGraph({ rankdir: 'LR', ranksep: 150, nodesep: 80 });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    return {
      ...node,
      targetPosition: Position.Left,
      sourcePosition: Position.Right,
      position: {
        x: nodeWithPosition.x - nodeWidth / 2,
        y: nodeWithPosition.y - nodeHeight / 2,
      },
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

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/network/graph');
      if (!res.ok) throw new Error('Failed to fetch graph');
      const data: NetworkGraph = await res.json();

      // Transform to React Flow format
      const flowNodes: Node[] = data.nodes.map(n => {
        let className = 'border rounded-xl shadow-sm p-2 ';
        if (n.type === 'internet') className += '!bg-sky-100 dark:!bg-sky-900 !border-sky-200 dark:!border-sky-800 !text-sky-900 dark:!text-sky-100';
        else if (n.type === 'router') className += '!bg-amber-100 dark:!bg-amber-900 !border-amber-200 dark:!border-amber-800 !text-amber-900 dark:!text-amber-100';
        else if (n.type === 'proxy') className += '!bg-emerald-100 dark:!bg-emerald-900 !border-emerald-200 dark:!border-emerald-800 !text-emerald-900 dark:!text-emerald-100';
        else if (n.type === 'service') className += '!bg-indigo-100 dark:!bg-indigo-900 !border-indigo-200 dark:!border-indigo-800 !text-indigo-900 dark:!text-indigo-100';
        else className += '!bg-white dark:!bg-gray-800 !border-gray-200 dark:!border-gray-700 !text-gray-900 dark:!text-white';

        return {
            id: n.id,
            type: 'default',
            position: { x: 0, y: 0 },
            className,
            data: { 
                originalType: n.type,
                rawData: n.rawData,
                label: (
                    <div className="flex flex-col items-center min-w-[150px]">
                        <div className="font-bold text-sm mb-1">{n.label}</div>
                        
                        {/* Sublabel (IP/Image) */}
                        {n.subLabel && (
                            <div className={`text-xs mb-1 truncate max-w-full ${n.type === 'internet' || n.type === 'router' || n.type === 'proxy' ? '!opacity-100' : '!text-gray-600 dark:!text-gray-300'}`}>
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
                    <button 
                        onClick={() => setSelectedNodeData(null)}
                        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
                    >
                        <X size={20} />
                    </button>
                </div>
                <div className="space-y-4">
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
      </div>
    </div>
  );
}
