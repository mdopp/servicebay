'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { 
  ReactFlow, 
  Background, 
  Controls, 
  MiniMap, 
  useNodesState, 
  useEdgesState,
  Node,
  Edge,
  Connection,
  addEdge,
  Panel,
  MarkerType,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getLayoutedElements } from '@/lib/network/layout';
import { NetworkGraph } from '@/lib/network/types';
import { RefreshCw, X, Trash2, Edit, Info, Globe, Search } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useToast } from '@/providers/ToastProvider';
import ExternalLinkModal from '@/components/ExternalLinkModal';
import Link from 'next/link';

// Custom Edge Component
const CustomEdge = ({
  id: _id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}: any) => {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  if (!label) {
      return <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />;
  }

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan bg-white dark:bg-gray-800 px-2 py-1 rounded border border-gray-200 dark:border-gray-700 shadow-sm text-[10px] font-mono text-gray-600 dark:text-gray-400 text-center z-10"
        >
          {String(label).split('\n').map((line: string, i: number) => (
            <div key={i} className={i === 0 && String(label).includes('\n') ? "font-bold border-b border-gray-100 dark:border-gray-700/50 mb-0.5 pb-0.5" : ""}>
                {line}
            </div>
          ))}
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

// Custom Node Component
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CustomNode = ({ data }: any) => {
  const isGroup = ['group', 'proxy', 'service', 'pod'].includes(data.type);
  const isGateway = data.rawData?.type === 'gateway';
  
  const typeLabels: Record<string, string> = {
      container: 'Container',
      service: 'Managed Service',
      pod: 'Pod',
      router: 'Internet Gateway',
      link: 'External Link',
      proxy: 'Reverse Proxy',
      internet: 'Internet',
      device: 'Network Device'
  };

  // Color Mapping
  const typeColors: Record<string, string> = {
      container: 'border-blue-400 dark:border-blue-600 bg-blue-100 dark:bg-blue-900/40',
      service: 'border-purple-400 dark:border-purple-600 bg-purple-100 dark:bg-purple-900/40',
      pod: 'border-pink-400 dark:border-pink-600 bg-pink-100 dark:bg-pink-900/40',
      router: 'border-orange-400 dark:border-orange-600 bg-orange-100 dark:bg-orange-900/40',
      internet: 'border-gray-400 dark:border-gray-600 bg-gray-100 dark:bg-gray-800/60',
      proxy: 'border-emerald-400 dark:border-emerald-600 bg-emerald-100 dark:bg-emerald-900/40',
      link: 'border-cyan-400 dark:border-cyan-600 bg-cyan-100 dark:bg-cyan-900/40',
      device: 'border-indigo-400 dark:border-indigo-600 bg-indigo-100 dark:bg-indigo-900/40',
  };

  const nodeColor = typeColors[data.type] || 'border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type DetailItem = { label: string; value: any; full?: boolean };

  // Helper to get display details based on type
  const getDetails = (): DetailItem[] => {
      const raw = data.rawData || {};
      const common: DetailItem[] = [];

      if (data.type === 'container') {
          const items = [
              ...common,
              { label: 'Created', value: raw.Created ? new Date(raw.Created * 1000).toLocaleDateString() : null },
              { label: 'Status', value: raw.Status },
          ];
          if (raw.hostNetwork) {
              items.push({ label: 'Network', value: 'Host' });
          }
          return items;
      }
      if (data.type === 'service') {
          const items = [
              ...common,
              { label: 'State', value: raw.active ? 'Active' : 'Inactive' },
              { label: 'Load', value: raw.load },
          ];
          if (raw.hostNetwork) {
              items.push({ label: 'Network', value: 'Host' });
          }
          return items;
      }
      if (data.type === 'link') {
          return [
              ...common,
              { label: 'URL', value: raw.url, full: true },
          ];
      }
      if (data.type === 'router') {
          return [
              { label: 'Ext IP', value: raw.externalIP },
              { label: 'Int IP', value: raw.internalIP },
              { label: 'Uptime', value: raw.uptime ? `${Math.floor(raw.uptime / 3600)}h` : 'N/A', full: true }
          ];
      }
      if (data.type === 'device') {
          return [];
      }
      return common;
  };

  const details = getDetails();

  if (data.type === 'internet') {
      return (
        <div className="flex flex-col items-center justify-center w-32 h-32 rounded-full bg-blue-50 dark:bg-blue-900/20 border-4 border-blue-200 dark:border-blue-800 shadow-lg relative group">
            <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-blue-400 !-right-1.5" />
            <Globe className="w-12 h-12 text-blue-500 dark:text-blue-400 mb-1" />
            <span className="font-bold text-sm text-blue-700 dark:text-blue-300 uppercase tracking-wider">Internet</span>
        </div>
      );
  }

  return (
    <div className={`w-full ${isGroup ? 'h-full' : 'min-w-[320px] h-auto'}`}>
      {/* Handles for connecting */}
      <Handle type="target" position={Position.Left} className="!w-3 !h-3 !bg-blue-400" />
      <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-blue-400" />
      
      {isGroup ? (
         <div className={`w-full h-full rounded-xl border-2 flex flex-col justify-between p-2 transition-all bg-transparent ${
            isGateway 
                ? 'border-emerald-200 dark:border-emerald-800' 
                : 'border-gray-300 dark:border-gray-700'
        }`}>
            <div className="flex justify-between items-start w-full">
                <div className={`self-start px-3 py-1.5 rounded-md text-sm font-bold uppercase tracking-wider border shadow-sm flex items-center gap-2 ${
                    isGateway 
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900 dark:text-emerald-300 dark:border-emerald-800' 
                        : 'bg-white text-gray-600 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700'
                }`}>
                    {data.status && (
                        <div className={`w-2.5 h-2.5 rounded-full ${data.status === 'up' ? 'bg-green-500' : 'bg-red-500'}`} />
                    )}
                    {data.label}
                </div>

                {/* Show Ports for Groups if available */}
                {data.ports && data.ports.length > 0 && (
                    <div className="flex flex-col gap-1 items-end">
                        {data.ports.map((port: number | { host: number, container: number }, idx: number) => {
                            const isMapping = typeof port === 'object';
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const hostPort = isMapping ? (port as any).host : port;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const containerPort = isMapping ? (port as any).container : null;
                            
                            return (
                                <div key={idx} className="px-2 py-0.5 rounded text-[10px] font-mono bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 shadow-sm flex items-center gap-1">
                                    <a 
                                        href={`http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${hostPort}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="hover:text-blue-500 hover:underline"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        :{hostPort}
                                    </a>
                                    {containerPort && (
                                        <span className="text-gray-400 dark:text-gray-500">
                                            (to :{containerPort})
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
      ) : (
        <div className={`w-full h-full rounded-xl border shadow-sm hover:shadow-md transition-all p-4 flex flex-col gap-3 ${nodeColor}`}>
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800/50 pb-2">
                <div className="font-bold text-lg text-gray-900 dark:text-gray-100 truncate pr-2" title={data.label}>
                    {data.label}
                </div>
                {data.status && (
                    <div className={`w-3 h-3 rounded-full shrink-0 ${data.status === 'up' ? 'bg-green-500' : 'bg-red-500'}`} />
                )}
            </div>
            
            <div className="flex-1 flex flex-col gap-2 min-h-0">
                {data.subLabel && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 font-mono bg-white/50 dark:bg-black/20 px-2 py-1 rounded break-all" title={data.subLabel}>
                        {data.subLabel}
                    </div>
                )}

                {/* Dynamic Details Grid */}
                {details.length > 0 && (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                        {details.map((d, i) => d.value && (
                            <div key={i} className={`flex flex-col min-w-0 ${d.full ? 'col-span-2' : ''}`}>
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold">{d.label}</span>
                                {d.label === 'URL' ? (
                                    <a 
                                        href={d.value} 
                                        target="_blank" 
                                        rel="noopener noreferrer" 
                                        className="text-sm text-blue-600 dark:text-blue-400 font-medium break-words hover:underline" 
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {d.value}
                                    </a>
                                ) : (
                                    <span className="text-sm text-gray-800 dark:text-gray-200 font-medium break-words" title={String(d.value)}>{d.value}</span>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* Verified Domains List */}
                {data.metadata?.verifiedDomains && data.metadata.verifiedDomains.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800/50">
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold block mb-1">Verified Domains</span>
                        <div className="flex flex-wrap gap-1">
                            {data.metadata.verifiedDomains.map((domain: string) => (
                                <div key={domain} className="flex items-center gap-1.5 text-[10px] font-mono text-gray-700 dark:text-gray-300 px-1.5 py-0.5 bg-gray-50 dark:bg-gray-800 rounded border border-gray-100 dark:border-gray-700">
                                    <div className="w-1 h-1 rounded-full bg-green-500 shrink-0" />
                                    <span className="truncate max-w-[120px]" title={domain}>{domain}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {data.hostname && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 font-mono bg-white/50 dark:bg-black/20 px-2 py-1 rounded break-all flex items-center gap-1" title="Hostname">
                        <Globe size={10} className="opacity-50" />
                        {data.hostname}
                    </div>
                )}

                {data.metadata?.description && data.type !== 'link' && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2 mt-1 italic" title={data.metadata.description}>
                        {data.metadata.description}
                    </div>
                )}
                
                <div className="mt-auto pt-3 flex items-center justify-between border-t border-gray-100 dark:border-gray-800/50">
                    <div className="flex flex-wrap gap-1.5">
                        {data.ports && data.ports.map((p: string | number | { host: number, container: number }, idx: number) => {
                            const isMapping = typeof p === 'object';
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const hostPort = isMapping ? (p as any).host : p;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const containerPort = isMapping ? (p as any).container : null;

                            const link = data.metadata?.link;
                            const content = (
                                <span className="text-[11px] font-medium px-2 py-0.5 bg-white dark:bg-black/20 text-blue-600 dark:text-blue-400 rounded border border-blue-100 dark:border-blue-800/30 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors cursor-pointer flex items-center gap-1">
                                    <span>:{hostPort}</span>
                                    {containerPort && <span className="text-gray-400 dark:text-gray-500 opacity-75">(to :{containerPort})</span>}
                                </span>
                            );

                            if (link) {
                                return (
                                    <a 
                                        key={idx} 
                                        href={link} 
                                        target="_blank" 
                                        rel="noopener noreferrer" 
                                        onClick={(e) => e.stopPropagation()}
                                        title={`Open ${link}`}
                                    >
                                        {content}
                                    </a>
                                );
                            }
                            return <React.Fragment key={idx}>{content}</React.Fragment>;
                        })}
                    </div>
                    
                    <span className="text-[10px] font-semibold px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded border border-gray-200 dark:border-gray-700 uppercase tracking-wider ml-2 whitespace-nowrap">
                        {typeLabels[data.type] || data.type}
                    </span>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};

const nodeTypes = {
  custom: CustomNode,
};

const edgeTypes = {
  custom: CustomEdge,
};

export default function NetworkPlugin() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [selectedNodeData, setSelectedNodeData] = useState<any>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const { addToast } = useToast();

  // Link Modal State
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkForm, setLinkForm] = useState({ name: '', url: '', description: '', monitor: false });

  // Connection Modal State
  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [connectionPort, setConnectionPort] = useState('');
  const [availablePorts, setAvailablePorts] = useState<number[]>([]);

  const onConnect = useCallback(
    (params: Connection) => {
        setPendingConnection(params);
        setConnectionPort('');
        
        // Find target node to get available ports
        const targetNode = nodes.find(n => n.id === params.target);
        if (targetNode && targetNode.data.ports && Array.isArray(targetNode.data.ports)) {
            // Extract ports (handle both number and object format)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ports = targetNode.data.ports.map((p: any) => {
                if (typeof p === 'object') return p.host || p.container;
                return p;
            }).filter((p: number) => p > 0);
            setAvailablePorts(ports);
            // If there's only one port, pre-select it? No, user might want generic link.
            // But user asked for default to be that port.
            if (ports.length > 0) {
                setConnectionPort(ports[0].toString());
            }
        } else {
            setAvailablePorts([]);
        }

        setShowConnectionModal(true);
    },
    [nodes]
  );

  const handleSaveConnection = async () => {
      if (!pendingConnection) return;

      // Optimistic update
      setEdges((eds) => addEdge(pendingConnection, eds));
      setShowConnectionModal(false);
      
      try {
        const res = await fetch('/api/network/edges', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: pendingConnection.source,
                target: pendingConnection.target,
                type: 'manual',
                port: connectionPort
            })
        });

        if (!res.ok) throw new Error('Failed');
        addToast('success', 'Connection created');
        fetchGraph(); // Rerender layout
      } catch {
        addToast('error', 'Failed to create connection');
        fetchGraph(); // Revert on error
      }
  };

  const matchesSearch = useCallback((node: Node, query: string) => {
    if (!query) return true;
    const q = query.toLowerCase();
    const data = node.data;
    const raw = data.rawData || {};
    
    // Check basic fields
    if (data.label && String(data.label).toLowerCase().includes(q)) return true;
    if (data.subLabel && String(data.subLabel).toLowerCase().includes(q)) return true;
    if (data.hostname && String(data.hostname).toLowerCase().includes(q)) return true;
    
    // Check ports
    if (data.ports && Array.isArray(data.ports)) {
        const portsStr = data.ports.map((p: number | { host: number, container: number }) => {
            if (typeof p === 'object') return `${p.host} ${p.container}`;
            return String(p);
        }).join(' ');
        if (portsStr.includes(q)) return true;
    }
    
    // Check raw data fields
    if (raw.url && String(raw.url).toLowerCase().includes(q)) return true;
    if (raw.externalIP && String(raw.externalIP).includes(q)) return true;
    if (raw.internalIP && String(raw.internalIP).includes(q)) return true;
    
    // Check verified domains
    if (data.metadata?.verifiedDomains && Array.isArray(data.metadata.verifiedDomains)) {
         if (data.metadata.verifiedDomains.some((d: string) => d.toLowerCase().includes(q))) return true;
    }
    
    return false;
  }, []);

  const applyFilter = useCallback((nodesToFilter: Node[], query: string) => {
    return nodesToFilter.map(node => {
        const isMatch = matchesSearch(node, query);
        const targetOpacity = isMatch ? 1 : 0.2;
        const targetFilter = isMatch ? 'none' : 'grayscale(100%)';
        
        if (node.style?.opacity === targetOpacity && node.style?.filter === targetFilter) {
            return node;
        }

        return {
            ...node,
            style: {
                ...node.style,
                opacity: targetOpacity,
                filter: targetFilter,
                transition: 'all 0.3s ease'
            }
        };
    });
  }, [matchesSearch]);

  const searchQueryRef = React.useRef(searchQuery);
  useEffect(() => {
      searchQueryRef.current = searchQuery;
      setNodes((nds) => applyFilter(nds, searchQuery));
  }, [searchQuery, applyFilter, setNodes]);

  const fetchGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/network/graph');
      if (!res.ok) throw new Error('Failed to fetch graph');
      const data: NetworkGraph = await res.json();

      // Transform to React Flow format
      const flowNodes: Node[] = data.nodes.map(n => {
        const isGroup = ['group', 'proxy', 'service', 'pod'].includes(n.type);
        
        return {
            id: n.id,
            type: 'custom', // Use our custom node
            position: { x: 0, y: 0 }, // Initial position, will be set by ELK
            data: {
                ...n,
                label: n.label,
                type: n.type,
                status: n.status,
                subLabel: n.subLabel,
                ports: n.ports,
                rawData: n.rawData
            },
            parentId: n.parentNode,
            extent: n.parentNode ? 'parent' : undefined,
            style: isGroup ? { 
                width: 400, // Initial guess, ELK will resize
                height: 200,
                backgroundColor: 'rgba(0,0,0,0.05)',
                border: '1px dashed #ccc'
            } : undefined
        };
      });

      const flowEdges: Edge[] = data.edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        type: 'smoothstep',
        markerEnd: {
            type: MarkerType.ArrowClosed,
        },
        data: {
            isManual: e.isManual,
            state: e.state
        },
        animated: e.state === 'active'
      }));

      // Apply Layout
      const layouted = await getLayoutedElements(flowNodes, flowEdges);
      
      setNodes(applyFilter(layouted.nodes, searchQueryRef.current));
      setEdges(layouted.edges);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [setNodes, setEdges, applyFilter]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const handleEditLink = () => {
      if (!selectedNodeData) return;
      const { name, url, description, monitor } = selectedNodeData.rawData;
      
      setLinkForm({
          name: name,
          url: url || '',
          description: description || '',
          monitor: monitor || false
      });
      setShowLinkModal(true);
  };

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
        fetchGraph(); 
        
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



  const handleDeleteEdge = async () => {
      if (!selectedEdge) return;
      try {
          const res = await fetch(`/api/network/edges?id=${selectedEdge}`, {
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

  return (
    <div className="h-full flex flex-col">
      <PageHeader 
        title="Map" 
        showBack={false} 
        helpId="network"
        actions={
            <button 
                onClick={fetchGraph}
                disabled={loading}
                className="p-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
            >
                <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
            </button>
        }
      >
        <div className="relative flex-1 max-w-md min-w-[100px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input 
                type="text" 
                placeholder="Search..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
            />
        </div>
      </PageHeader>
      
      <div className="flex-1 bg-gray-50 dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 relative overflow-hidden">
        <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            minZoom={0.1}
            maxZoom={2}
            defaultEdgeOptions={{
                type: 'custom',
                animated: true,
                style: { stroke: '#b1b1b7', strokeWidth: 2 },
            }}
            onNodeClick={(_, node) => {
                setSelectedNodeData(node.data);
                setSelectedEdge(null);
            }}
            onEdgeClick={(_, edge) => {
                setSelectedEdge(edge.id);
                setSelectedNodeData(null);
            }}
        >
            <Background color="#999" gap={16} size={1} className="opacity-10" />
            <Controls 
                showInteractive={false} 
                className="!bg-white dark:!bg-gray-800 !border-gray-200 dark:!border-gray-700 shadow-lg [&>button]:!bg-white dark:[&>button]:!bg-gray-800 [&>button]:!border-gray-100 dark:[&>button]:!border-gray-700 [&>button]:!text-gray-900 dark:[&>button]:!text-gray-100 [&>button:hover]:!bg-gray-100 dark:[&>button:hover]:!bg-gray-700 [&>button>svg]:!fill-current"
            />
            <MiniMap 
                className="!bg-white dark:!bg-gray-800 !border-gray-200 dark:!border-gray-700 shadow-lg scale-50 origin-bottom-right md:scale-100"
                maskColor="transparent"
                nodeStrokeColor={(n) => {
                    const type = n.data?.type as string;
                    switch (type) {
                        case 'container': return '#2563eb'; // blue-600
                        case 'service': return '#9333ea'; // purple-600
                        case 'pod': return '#db2777'; // pink-600
                        case 'router': return '#ea580c'; // orange-600
                        case 'internet': return '#4b5563'; // gray-600
                        case 'proxy': return '#059669'; // emerald-600
                        case 'link': return '#0891b2'; // cyan-600
                        case 'device': return '#4f46e5'; // indigo-600
                        case 'group': return '#d1d5db'; // gray-300
                        default: return '#9ca3af';
                    }
                }}
                nodeColor={(n) => {
                    const type = n.data?.type as string;
                    switch (type) {
                        case 'container': return '#60a5fa'; // blue-400
                        case 'service': return 'transparent';
                        case 'pod': return 'transparent';
                        case 'proxy': return 'transparent';
                        case 'router': return '#fb923c'; // orange-400
                        case 'internet': return '#9ca3af'; // gray-400
                        case 'link': return '#22d3ee'; // cyan-400
                        case 'device': return '#818cf8'; // indigo-400
                        case 'group': return 'transparent';
                        default: return '#d1d5db';
                    }
                }}
            />
            <Panel position="top-right" className="bg-white dark:bg-gray-800 p-2 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
                <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Legend</div>
                <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-green-500" />
                        <span className="text-xs">Healthy</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full bg-red-500" />
                        <span className="text-xs">Issue</span>
                    </div>
                </div>
            </Panel>
        </ReactFlow>

      </div>
      
      {/* Link Modal */}
      <ExternalLinkModal
        isOpen={showLinkModal}
        onClose={() => setShowLinkModal(false)}
        onSave={handleSaveLink}
        form={linkForm}
        setForm={setLinkForm}
        isEditing={true}
      />

      {/* Connection Modal */}
      {showConnectionModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 w-96 max-w-full m-4">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-bold">Create Connection</h3>
                    <button onClick={() => setShowConnectionModal(false)} className="text-gray-500 hover:text-gray-700">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                            Target Port
                        </label>
                        
                        {availablePorts.length > 0 && (
                            <div className="space-y-2 mb-3">
                                {availablePorts.map(port => (
                                    <label key={port} className="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 border border-transparent hover:border-gray-200 dark:hover:border-gray-700">
                                        <input
                                            type="radio"
                                            name="targetPort"
                                            value={port}
                                            checked={connectionPort === port.toString()}
                                            onChange={(e) => setConnectionPort(e.target.value)}
                                            className="text-blue-600 focus:ring-blue-500"
                                        />
                                        <span className="text-sm font-mono">:{port}</span>
                                    </label>
                                ))}
                                <label className="flex items-center gap-2 cursor-pointer p-2 rounded hover:bg-gray-50 dark:hover:bg-gray-700/50 border border-transparent hover:border-gray-200 dark:hover:border-gray-700">
                                    <input
                                        type="radio"
                                        name="targetPort"
                                        value="custom"
                                        checked={!availablePorts.includes(parseInt(connectionPort))}
                                        onChange={() => setConnectionPort('')}
                                        className="text-blue-600 focus:ring-blue-500"
                                    />
                                    <span className="text-sm">Other</span>
                                </label>
                            </div>
                        )}

                        {(!availablePorts.length || !availablePorts.includes(parseInt(connectionPort))) && (
                             <input
                                type="number"
                                value={connectionPort}
                                onChange={(e) => setConnectionPort(e.target.value)}
                                placeholder="e.g. 8080"
                                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 focus:ring-2 focus:ring-blue-500 outline-none"
                                autoFocus={!availablePorts.length}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveConnection();
                                }}
                            />
                        )}
                       
                        <p className="text-xs text-gray-500 mt-1">
                            {availablePorts.length > 0 ? 'Select a known port or enter a custom one.' : 'Enter the target port for this connection.'}
                        </p>
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <button
                            onClick={() => setShowConnectionModal(false)}
                            className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSaveConnection}
                            className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors"
                        >
                            Create Link
                        </button>
                    </div>
                </div>
            </div>
        </div>
      )}
      
      {/* Context Menu / Details Panel */}
      {selectedNodeData && (
          <div className="absolute right-4 top-20 w-80 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-4 z-10 animate-in slide-in-from-right-5">
              <div className="flex justify-between items-start mb-4 gap-2">
                  <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-lg truncate" title={selectedNodeData.label}>{selectedNodeData.label}</h3>
                      <div className="text-xs text-gray-500 font-mono truncate" title={selectedNodeData.id}>{selectedNodeData.id}</div>
                  </div>
                  <button onClick={() => setSelectedNodeData(null)} className="text-gray-400 hover:text-gray-600 shrink-0">
                      <X size={16} />
                  </button>
              </div>
              
              <div className="space-y-3 max-h-[80vh] overflow-y-auto pr-1">
                  <div className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-900 rounded-lg">
                      <span className="text-sm text-gray-500">Status</span>
                      <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          selectedNodeData.status === 'up' 
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' 
                              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                      }`}>
                          {selectedNodeData.status?.toUpperCase() || 'UNKNOWN'}
                      </span>
                  </div>

                  {/* Actions */}
                  <div className="grid grid-cols-1 gap-2">
                    {selectedNodeData.type === 'link' && (
                        <button 
                            onClick={handleEditLink}
                            className="w-full flex items-center justify-center gap-2 p-2 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg transition-colors text-sm font-medium"
                        >
                            <Edit size={14} />
                            Edit Link
                        </button>
                    )}

                    {selectedNodeData.type === 'container' && selectedNodeData.rawData?.Id && (
                        <Link 
                            href={`/containers/${selectedNodeData.rawData.Id}`}
                            className="w-full flex items-center justify-center gap-2 p-2 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg transition-colors text-sm font-medium"
                        >
                            <Info size={14} />
                            Inspect Container
                        </Link>
                    )}

                    {selectedNodeData.type === 'service' && selectedNodeData.rawData?.name && (
                        <Link 
                            href={`/edit/${selectedNodeData.rawData.name}`}
                            className="w-full flex items-center justify-center gap-2 p-2 bg-purple-50 text-purple-600 hover:bg-purple-100 rounded-lg transition-colors text-sm font-medium"
                        >
                            <Edit size={14} />
                            Edit Service
                        </Link>
                    )}

                    {selectedNodeData.type === 'proxy' && (
                        <Link 
                            href="/proxy"
                            className="w-full flex items-center justify-center gap-2 p-2 bg-emerald-50 text-emerald-600 hover:bg-emerald-100 rounded-lg transition-colors text-sm font-medium"
                        >
                            <Edit size={14} />
                            Configure Proxy
                        </Link>
                    )}

                    {selectedNodeData.rawData?.metadata?.link && (
                        <Link 
                            href={selectedNodeData.rawData.metadata.link}
                            target="_blank"
                            className="block w-full text-center p-2 bg-gray-900 text-white hover:bg-gray-800 rounded-lg transition-colors text-sm font-medium"
                        >
                            Open Service ↗
                        </Link>
                    )}
                  </div>

                  {/* Network Info */}
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
                      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Network Details</h4>
                      <div className="space-y-1 text-sm">
                          {selectedNodeData.ip && (
                              <div className="flex justify-between">
                                  <span className="text-gray-500">IP Address</span>
                                  <span className="font-mono">{selectedNodeData.ip}</span>
                              </div>
                          )}
                          {selectedNodeData.ports && selectedNodeData.ports.length > 0 && (
                              <div className="flex justify-between">
                                  <span className="text-gray-500">Ports</span>
                                  <span className="font-mono">{selectedNodeData.ports.join(', ')}</span>
                              </div>
                          )}
                          {selectedNodeData.rawData?.MacAddress && (
                              <div className="flex justify-between">
                                  <span className="text-gray-500">MAC</span>
                                  <span className="font-mono">{selectedNodeData.rawData.MacAddress}</span>
                              </div>
                          )}
                      </div>
                  </div>

                  {/* Debug Info */}
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
                      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Debug Info</h4>
                      <div className="space-y-1 text-xs font-mono text-gray-600 dark:text-gray-400">
                          <div className="flex justify-between">
                              <span>Node ID</span>
                              <span>{selectedNodeData.id}</span>
                          </div>
                          <div className="flex justify-between">
                              <span>Type</span>
                              <span>{selectedNodeData.type}</span>
                          </div>
                          {selectedNodeData.parentId && (
                              <div className="flex justify-between">
                                  <span>Parent</span>
                                  <span>{selectedNodeData.parentId}</span>
                              </div>
                          )}
                      </div>
                  </div>

                  {/* Raw Data */}
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-3">
                      <h4 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Raw Data</h4>
                      <div className="bg-gray-50 dark:bg-gray-900 p-2 rounded-lg overflow-x-auto">
                          <pre className="text-[10px] font-mono text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-all">
                              {JSON.stringify(selectedNodeData.rawData, null, 2)}
                          </pre>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {selectedEdge && (
          <div className="absolute right-4 top-20 w-64 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 p-4 z-10 animate-in slide-in-from-right-5">
              <div className="flex justify-between items-start mb-4">
                  <h3 className="font-bold">Connection</h3>
                  <button onClick={() => setSelectedEdge(null)} className="text-gray-400 hover:text-gray-600">
                      <X size={16} />
                  </button>
              </div>
              <p className="text-sm text-gray-500 mb-4">
                  Manual connection between nodes.
              </p>
              <button 
                  onClick={handleDeleteEdge}
                  className="w-full flex items-center justify-center gap-2 p-2 bg-red-50 text-red-600 hover:bg-red-100 rounded-lg transition-colors text-sm font-medium"
              >
                  <Trash2 size={14} />
                  Remove Connection
              </button>
          </div>
      )}
    </div>
  );
}
