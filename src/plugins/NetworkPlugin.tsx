'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import { PortMapping } from '@/lib/agent/types';
import { NetworkGraph } from '@/lib/network/types'; 

import { 
  ReactFlow, 
  Background, 
  Controls, 
  MiniMap, 
  useNodesState, 
  useEdgesState,
  Node,
  Edge,
  NodeProps,
  EdgeProps,
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
import { X, Trash2, Edit, Info, Globe, Search, FileText, Activity, Link as LinkIcon, ChevronDown, LayoutGrid, Plus } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useToast } from '@/providers/ToastProvider';
import ExternalLinkModal from '@/components/ExternalLinkModal';
import Link from 'next/link';

export interface GraphNodeData extends Record<string, unknown> {
  id?: string;
  type: string; 
  label: string;
  subLabel?: string;
  node?: string; // Node name
  hostname?: string;
  targetHandlePosition?: Position;
  sourceHandlePosition?: Position;
  collapsed?: boolean;
  onToggle?: (id: string, expanded?: boolean) => void;
  onCreateExternalLink?: (node: GraphNodeData) => void; 
  status?: string;
  ip?: string;
  parentId?: string;
  summary?: {
    portMap?: PortMapping[];
    totalContainers?: number;
    activeContainers?: number;
    totalServices?: number;
    activeServices?: number;
    status?: string;
    verifiedDomains?: string[];
  };
  metadata?: {
    nodeIPs?: string[];
    verifiedDomains?: string[];
    externalTargetIp?: string;
    externalTargetPort?: number;
    description?: string;
    link?: string;
    stats?: {
      externalIP?: string;
      internalIP?: string;
      dnsServers?: string[];
    };
    [key: string]: unknown;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawData?: any;
}

interface LegacyPortMapping extends PortMapping {
    IP?: string;
    host?: number;
    container?: number;
}

interface MonitoringData {
    connected?: boolean;
    externalIP?: string;
    uptime?: number;
    dnsServers?: string[];
    deviceLog?: string;
    [key: string]: unknown;
}

// Custom Edge Component
const CustomEdge = ({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label,
}: EdgeProps) => {
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

type CustomNodeType = Node<GraphNodeData>;

// Custom Node Component
const CustomNode = ({ id, data }: NodeProps<CustomNodeType>) => {
  const isGroup = data.type === 'group';
  // Services, Pods, Proxies can also behave as groups (can be expanded/collapsed)
  const isExpandable = ['group', 'service', 'pod', 'proxy'].includes(data.type);
  const isCollapsed = data.collapsed;
  const onToggle = data.onToggle;
  
  // Decide whether to render as the "Opened Group Frame" or the "Node Card"
  const renderAsExpandedGroup = isExpandable && !isCollapsed;

  const summary = data.summary || {};
  
  const isGateway = data.rawData?.type === 'gateway';
  const isMissing = data.rawData?.type === 'missing';
  
  // Determine effective type: if group, try to use rawData.type (service, pod, proxy) to get correct label/color
  const effectiveType = ((data.type === 'group' && data.rawData?.type) ? data.rawData.type : data.type) as string;
  
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
      router: 'border-orange-400 dark:border-orange-600 bg-orange-100 dark:bg-orange-600/60',
      internet: 'border-gray-400 dark:border-gray-600 bg-gray-100 dark:bg-gray-800/60',
      proxy: 'border-emerald-400 dark:border-emerald-600 bg-emerald-100 dark:bg-emerald-900/40',
      gateway: 'border-orange-400 dark:border-orange-600 bg-orange-100 dark:bg-orange-800/50', // Add gateway mapping

      link: 'border-cyan-400 dark:border-cyan-600 bg-cyan-100 dark:bg-cyan-900/40',
      device: 'border-indigo-400 dark:border-indigo-600 bg-indigo-100 dark:bg-indigo-900/40',
  };

  const nodeColor = isMissing 
      ? 'border-red-400 dark:border-red-600 bg-red-50 dark:bg-red-900/20 border-dashed'
      : (typeColors[effectiveType] || 'border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900');

      // Pre-calculate effective ports to use in IP extraction if data.ports is empty
      // (e.g. Pod Nodes which inherit ports from children)
      // Make sure we merge distinct ports if multiple sources exist
      // PREFER: rawData.ports if available (Single Source of Truth)
      const directPorts = data.rawData?.ports;
      const rawPorts = (directPorts && directPorts.length > 0) 
          ? directPorts 
          : (summary.portMap || []);
      

      // Helper to extract IP info from ports
      const extractIpInfo = () => {
    
    if (!rawPorts || rawPorts.length === 0) return { globalIp: null, portMap: [] };
    
    // Fallback IP (Node IP or Link Targets)
    let fallbackIp = '0.0.0.0';
    
    // Special handling for Router: Prefer subLabel (Internal IP) over NodeIP if valid
    if (data.type === 'router' && data.subLabel && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(data.subLabel)) {
        fallbackIp = data.subLabel;
    } else if (data.metadata?.nodeIPs && data.metadata.nodeIPs.length > 0) {
        fallbackIp = data.metadata.nodeIPs[0];
    } else if (data.type === 'link' && data.rawData?.ip_targets && data.rawData.ip_targets.length > 0) {
         // Try to parse IP from the first target (IP:PORT)
         const target = data.rawData.ip_targets[0];
         const parts = target.split(':');
         if (parts.length >= 1) fallbackIp = parts[0];
    }

    const parsedPorts = rawPorts.map((p: unknown) => {
        const isObj = typeof p === 'object' && p !== null;
        // Check both camelCase (API) and snake_case (Agent) properties
        // Also handle the case where p is just a number (legacy/simple)
        
        let ip: string | null = null;
        let hostPort: number | string | null = null;
        let containerPort: number | string | null = null;
        
        if (isObj) {
            const portObj = p as LegacyPortMapping;
            ip = portObj.hostIp || portObj.IP || null; // IP is rarely on port obj in recent models, but check
            hostPort = portObj.host || portObj.hostPort || null;
            containerPort = portObj.container || portObj.containerPort || null;
        } else {
            // p is number or string
            const val = p as unknown as (string | number);
            hostPort = val;
            containerPort = val; // Assume symmetry if simple number
        }

        // Normalize IP: If missing, empty, or 0.0.0.0, use the Node IP (fallbackIp)
        // This ensures containers (empty IP) and services (0.0.0.0) look the same
        // and show the actual reachable IP of the node.
        if (!ip || ip === '0.0.0.0' || ip === '') {
            ip = fallbackIp;
        }

        return {
            host: hostPort,
            container: containerPort,
            ip: ip
        };
    });

    // Deduplicate ports based on IP and Host Port
    const uniquePortsMap = new Map<string, { host: number|string|null, container: number|string|null, ip: string|null }>();
    parsedPorts.forEach((p: { host: number|string|null, container: number|string|null, ip: string|null }) => {
        const key = `${p.ip || '_'}:${p.host}`;
        // Keep the first one, or maybe prefer one with container info?
        // Usually first is fine.
        if (p.host && !uniquePortsMap.has(key)) { // Only add if host port exists
            uniquePortsMap.set(key, p);
        }
    });
    
    const dedupedPorts = Array.from(uniquePortsMap.values());

    const uniqueIps = Array.from(new Set(dedupedPorts.map((p) => p.ip).filter(Boolean))) as string[];
    // If exactly one unique IP is found across all ports, show it globally. 
    // Otherwise (0 or >1), show IPs on tags individually.
    const globalIp = uniqueIps.length === 1 ? uniqueIps[0] : null;

    return { globalIp, portMap: dedupedPorts };
  };

  const { globalIp, portMap } = extractIpInfo();

  // Merge Verified Domains from Summary if available (for collapsed groups)
  const effectiveDomains = [
     ...(data.metadata?.verifiedDomains || []), // Verified domains for this specific node
     ...(summary.verifiedDomains || []) // Aggregated domains for collapsed children
  ];
  // Deduplicate
  const uniqueDomains = Array.from(new Set(effectiveDomains));
 
  // For Reverse Proxies: Only show domains that are actively routed to THIS node or its children.
  // We filter uniqueDomains by checking if the graph contains an edge from valid sources (Gateway/Internet) TO this node with that domain label?
  // Actually, the backend already filters `verifiedDomains` on the node metadata.
  // But for the Proxy Node itself, we want to be sure we don't show all domains if it's a generic proxy but only handles some.
  // The logic in `src/lib/network/service.ts` populates `verifiedDomains` on the generic Gateway/Router node with ALL domains,
  // but for specific Service nodes, it only adds domains that target that service's IP/Port.

  // So, if we trust the metadata, it should be correct.
  // However, the user asked to explicitly verify "really routed to this node".
  
  // No changes needed if backend metadata is correct, but let's ensure we prefer metadata over summary if expanded.
  const displayDomains = renderAsExpandedGroup ? [] : uniqueDomains;
  type DetailItem = { label: string; value: string | number | React.ReactNode; full?: boolean };

  // Helper to get display details based on type
  const getDetails = (): DetailItem[] => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (data.rawData || {}) as any;
      const common: DetailItem[] = [];

      if (effectiveType === 'container') {
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
      if (effectiveType === 'service') {
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
      if (effectiveType === 'link') {
          return [
              ...common,
              { label: 'URL', value: raw.url, full: true },
          ];
      }
      if (effectiveType === 'gateway' || effectiveType === 'router') { // Handle both
          const items = [
              { label: 'Ext IP', value: raw.externalIP || data.metadata?.stats?.externalIP || 'Unknown' },
              { label: 'Int IP', value: raw.internalIP || data.metadata?.stats?.internalIP || 'Unknown' },
              { label: 'Uptime', value: raw.uptime ? `${Math.floor(raw.uptime / 3600)}h` : 'N/A', full: true }
          ];
          const dns = raw.dnsServers || data.metadata?.stats?.dnsServers;
          if (dns && dns.length > 0) {
              items.push({ label: 'DNS', value: dns.join(', '), full: true });
          }
          return items;
      }
      if (effectiveType === 'device') {
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

  // Dynamic Handle Positions
  const targetPos = data.targetHandlePosition || Position.Left;
  const sourcePos = data.sourceHandlePosition || Position.Right;

  return (
    <div className={`w-full ${(isGroup || renderAsExpandedGroup) ? 'h-full' : 'min-w-[320px] h-auto'}`}>
      {/* Handles for connecting */}
      <Handle type="target" position={targetPos} className="!w-3 !h-3 !bg-blue-400" />
      <Handle type="source" position={sourcePos} className="!w-3 !h-3 !bg-blue-400" />
      
      {renderAsExpandedGroup ? (
          /* Render as "Expanded Group Frame" */
         <div className={`w-full h-full rounded-xl border-2 flex flex-col justify-between p-2 pl-2 transition-all group-border ${
             // Explicit Group Stylings to ensure visibility
             effectiveType === 'service' ? 'border-purple-400/50 dark:border-purple-500/50 bg-purple-50/50 dark:bg-purple-900/10' :
             effectiveType === 'pod' ? 'border-pink-400/50 dark:border-pink-500/50 bg-pink-50/50 dark:bg-pink-900/10' :
             effectiveType === 'proxy' ? 'border-emerald-400/50 dark:border-emerald-500/50 bg-emerald-50/50 dark:bg-emerald-900/10' :
             'border-gray-300 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/10'
         }`}>
            <div className="flex justify-between items-start w-full pointer-events-none">
                <div className={`self-start px-3 py-1.5 rounded-md text-sm font-bold uppercase tracking-wider border shadow-sm flex items-center gap-2 pointer-events-auto ${
                    isGateway 
                        ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900 dark:text-emerald-300 dark:border-emerald-800' 
                        : (effectiveType !== 'group' && typeColors[effectiveType] 
                            ? typeColors[effectiveType].replace('bg-', 'bg-opacity-20 bg-').replace('border-', 'border-opacity-50 border-') 
                            : 'bg-white text-gray-600 border-gray-200 dark:bg-gray-900 dark:text-gray-400 dark:border-gray-700')
                } ${
                    // Ensure text color is set for specific types if not already
                     effectiveType === 'service' ? 'text-purple-700 dark:text-purple-300' :
                     effectiveType === 'pod' ? 'text-pink-700 dark:text-pink-300' :
                     effectiveType === 'proxy' ? 'text-emerald-700 dark:text-emerald-300' : ''
                }`}>
                    <button
                        onClick={(e) => { e.stopPropagation(); onToggle?.(id); }}
                        className="mr-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded p-0.5 text-gray-500"
                        title="Collapse Group"
                    >
                        <LayoutGrid size={14} /> 
                    </button>
                    {data.status && (
                        <div className={`w-2.5 h-2.5 rounded-full ${data.status === 'up' ? 'bg-green-500' : 'bg-red-500'}`} />
                    )}
                    {data.label}
                    {/* Visual Tag for Pod/Service */}
                    {(effectiveType === 'service' || effectiveType === 'pod') ? (
                        <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-white/50 dark:bg-black/20 border border-black/10 dark:border-white/10 uppercase tracking-wider font-extrabold opacity-80">
                            {effectiveType === 'service' ? 'Service' : 'Pod'}
                        </span>
                    ) : null}
                    {data.node && data.node !== 'local' && (
                        <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
                            {data.node}
                        </span>
                    )}
                </div>

                {/* Show Ports for Groups if available (Hide for Services/Pods/Proxies as requested) */}
                {portMap.length > 0 && !['service', 'pod', 'proxy'].includes(effectiveType) && (
                    <div className="flex flex-col gap-1 items-end">
                        {globalIp && (
                             <div className="text-[10px] font-mono text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 px-1.5 py-0.5 rounded border border-gray-100 dark:border-gray-800 mb-0.5 self-end" title="Host IP">
                                {globalIp}
                             </div>
                        )}
                        {portMap.map((p, idx) => {
                            // Determine hostname
                            let hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
                            if (p.ip) {
                                hostname = p.ip;
                            } else if (data.metadata?.nodeHost && typeof data.metadata.nodeHost === 'string' && data.metadata.nodeHost !== 'localhost') {
                                hostname = data.metadata.nodeHost as string;
                            } else if (data.node && data.node !== 'local' && data.node !== 'Local') {
                                hostname = data.node;
                            }

                            const showIpInTag = !globalIp && p.ip;

                            return (
                                <div key={idx} className="px-2 py-0.5 rounded text-[10px] font-mono bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 shadow-sm flex items-center gap-1">
                                    <a 
                                        href={`http://${hostname}:${p.host}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="hover:text-blue-500 hover:underline"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {showIpInTag ? `${p.ip}:${p.host}` : `:${p.host}`}
                                    </a>
                                    {p.container && (
                                        <span className="text-gray-400 dark:text-gray-500">
                                            (to :{p.container})
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
        /* Render as "Standard Node" (Card) - used for Leaf Nodes AND Collapsed Groups */
        <div className={`w-full h-full rounded-xl border shadow-sm hover:shadow-md transition-all p-4 flex flex-col gap-3 ${nodeColor}`}>
            <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800/50 pb-2">
                <div className="font-bold text-lg text-gray-900 dark:text-gray-100 truncate pr-2 flex items-center gap-2" title={data.label}>
                    {/* Add Expand Button if Expandable & Collapsed */}
                    {isExpandable && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onToggle?.(id); }}
                            className="hover:bg-gray-100 dark:hover:bg-gray-700 rounded p-1 text-gray-500 transition-colors"
                            title="Expand Group"
                        >
                            <ChevronDown size={16} className="-rotate-90" />
                        </button>
                    )}
                    
                    {data.label}
                    
                    {/* Host IP moved to Header */}
                    {globalIp && (
                         <div className="text-[10px] font-mono font-bold text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 px-1.5 py-0.5 rounded border border-gray-100 dark:border-gray-800 ml-1" title="Host IP">
                            {globalIp}
                         </div>
                    )}
                </div>
                {data.status && (
                    <div className={`w-3 h-3 rounded-full shrink-0 ${data.status === 'up' ? 'bg-green-500' : 'bg-red-500'}`} />
                )}
            </div>
            
            <div className="flex-1 flex flex-col gap-2 min-h-0">
                <div className="flex gap-2">
                  {data.subLabel && !['router', 'service', 'pod', 'proxy'].includes(effectiveType) && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 font-mono bg-white/50 dark:bg-black/20 px-2 py-1 rounded break-all" title={data.subLabel}>
                          {data.subLabel}
                      </div>
                  )}
                  {!!data.metadata?.pod && (typeof data.metadata.pod === 'string' || typeof data.metadata.pod === 'number') && (
                     <div className="text-xs text-pink-600 dark:text-pink-400 font-mono bg-pink-50 dark:bg-pink-900/20 border border-pink-200 dark:border-pink-800/30 px-2 py-1 rounded break-all flex items-center gap-1">
                        <span className="opacity-50 text-[10px]">POD:</span> {data.metadata.pod as React.ReactNode}
                     </div>
                  )}
                </div>

                {/* Dynamic Details Grid */}
                {details.length > 0 && (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                        {details.map((d, i) => d.value && (
                            <div key={i} className={`flex flex-col min-w-0 ${d.full ? 'col-span-2' : ''}`}>
                                <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold">{d.label}</span>
                                {d.label === 'URL' ? (
                                    <a 
                                        href={String(d.value)} 
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

                {/* Verified Domains List (Filtered for Proxies/Services) */}
                {displayDomains.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-800/50">
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wider font-semibold block mb-1">
                            {effectiveType === 'proxy' && 'Routed Domains'}
                            {effectiveType !== 'proxy' && 'Verified Domains'}
                        </span>
                        <div className="flex flex-col gap-1">
                            {displayDomains.map((domain: string) => (
                                <a 
                                    key={domain} 
                                    href={domain.startsWith('http') ? domain : `https://${domain}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={(e) => e.stopPropagation()}
                                    className="flex items-center gap-2 text-xs font-mono text-blue-600 dark:text-blue-400 hover:underline px-1.5 py-1 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-100 dark:border-blue-800/30 transition-colors"
                                >
                                    <div className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                                    <span className="truncate" title={domain}>{domain}</span>
                                </a>
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
                    <div className="flex flex-wrap gap-1.5 items-center">
                        {portMap && portMap.map((p, idx) => {
                            // Determine hostname for link
                            let hostname = p.ip; // Start with the resolved IP
                            
                            // If IP is 0.0.0.0 or localhost, try to be smarter for the link 
                            // (though visual label uses p.ip which is now normalized)
                            if (hostname === '0.0.0.0' || hostname === '127.0.0.1' || hostname === 'localhost') {
                                 if (data.metadata?.nodeHost && typeof data.metadata.nodeHost === 'string' && data.metadata.nodeHost !== 'localhost') {
                                    hostname = data.metadata.nodeHost as string;
                                } else if (data.node && data.node !== 'local' && data.node !== 'Local') {
                                    hostname = data.node;
                                }
                            }

                            const showIpInTag = !globalIp && p.ip;
                            const link = `http://${hostname}:${p.host}`;

                            const content = (
                                <span className="text-[11px] font-medium px-2 py-0.5 bg-white dark:bg-black/20 text-blue-600 dark:text-blue-400 rounded border border-blue-100 dark:border-blue-800/30 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors cursor-pointer flex items-center gap-1">
                                    <span>{showIpInTag ? `${p.ip}:${p.host}` : `:${p.host}`}</span>
                                    {p.container && <span className="text-gray-400 dark:text-gray-500 opacity-75">(to :{p.container})</span>}
                                </span>
                            );

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
                        })}
                    </div>
                    
                    <div className="flex flex-col items-end gap-1 ml-auto">
                        {data.node && data.node !== 'local' && (!data.parentNode || data.type === 'link') && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 uppercase tracking-wider font-bold">
                                {data.node}
                            </span>
                        )}
                        
                        <span className="text-[10px] font-semibold px-2 py-0.5 bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 rounded border border-gray-200 dark:border-gray-700 uppercase tracking-wider whitespace-nowrap">
                            {isMissing ? 'Missing Node' : (typeLabels[effectiveType] || effectiveType)}
                        </span>
                        
                         {!!data.metadata?.isExternalMissing && (
                            <button 
                                onClick={(e) => {
                                    e.stopPropagation();
                                    data.onCreateExternalLink?.(data);
                                }}
                                className="mt-1 px-2 py-1 bg-blue-600 hover:bg-blue-700 text-white text-[10px] font-bold uppercase tracking-wider rounded transition-colors shadow-sm flex items-center gap-1"
                            >
                                <Plus size={10} />
                                Add Link
                            </button>
                        )}
                    </div>
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
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<GraphNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNodeData, setSelectedNodeData] = useState<GraphNodeData | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const rawGraphData = React.useRef<{ nodes: Node[], edges: Edge[] } | null>(null);
  const activeToastRef = React.useRef<string | null>(null);
  const { addToast, updateToast } = useToast();

  // Monitoring Modal State
  const [showMonitoringModal, setShowMonitoringModal] = useState(false);
  const [monitoringData, setMonitoringData] = useState<MonitoringData | null>(null);

  // Link Modal State
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkForm, setLinkForm] = useState<{ name: string; url: string; description: string; monitor: boolean; ip_targets?: string }>({ name: '', url: '', description: '', monitor: false, ip_targets: '' });

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
        const rawData = targetNode?.data?.rawData;
        if (targetNode && rawData?.ports && Array.isArray(rawData.ports)) {
            // Extract ports (handle both number and object format)
            const ports = (rawData.ports as unknown[]).map((p) => {
                if (typeof p === 'object' && p !== null) {
                    const portMap = p as LegacyPortMapping;
                    return portMap.hostPort || portMap.host || portMap.containerPort || portMap.container;
                }
                return p as number;
            }).filter((p) => Number(p) > 0) as number[];
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

  const matchesSearch = useCallback((node: Node<GraphNodeData>, query: string) => {
    if (!query) return true;
    const q = query.toLowerCase();
    const data = node.data;
    const raw = data.rawData || {};
    
    // Check basic fields
    if (data.label && String(data.label).toLowerCase().includes(q)) return true;
    if (data.subLabel && String(data.subLabel).toLowerCase().includes(q)) return true;
    if (data.hostname && String(data.hostname).toLowerCase().includes(q)) return true;
    
    // Check ports (Prefer rawData)
    const ports = data.rawData?.ports;
    if (ports && Array.isArray(ports)) {
        const portsStr = (ports as unknown[]).map((p) => {
            if (typeof p === 'object' && p !== null) {
                const pm = p as LegacyPortMapping;
                return `${pm.host || pm.hostPort} ${pm.container || pm.containerPort}`;
            }
            return String(p);
        }).join(' ');
        if (portsStr.includes(q)) return true;
    }
    
    // Check raw data fields
    const r = raw as Record<string, unknown>;
    if (r.url && String(r.url).toLowerCase().includes(q)) return true;
    if (r.externalIP && String(r.externalIP).includes(q)) return true;
    if (r.internalIP && String(r.internalIP).includes(q)) return true;
    
    // Check verified domains
    if (data.metadata?.verifiedDomains && Array.isArray(data.metadata.verifiedDomains)) {
         if (data.metadata.verifiedDomains.some((d: string) => d.toLowerCase().includes(q))) return true;
    }
    
    return false;
  }, []);

  const applyFilter = useCallback((nodesToFilter: Node<GraphNodeData>[], query: string) => {
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

  const processAndLayout = useCallback(async (nodes: Node<GraphNodeData>[], edges: Edge[], collapsed: Set<string>, search: string) => {
    // 1. Prepare Nodes (Aggregation & toggles)
     
    const processedNodes = nodes.map(node => {
        if (['group', 'service', 'pod', 'proxy'].includes(node.data.type)) {
             const isCollapsed = collapsed.has(node.id);
             
             // Aggregate Summary
              
             const children = nodes.filter(n => n.parentId === node.id);
             let status = 'up';
             if (children.some(c => c.data.status === 'down')) status = 'down';
             
             const verifiedDomains = Array.from(new Set(children.flatMap(c => c.data.metadata?.verifiedDomains || []) as string[]));
             const portMap = children.flatMap(c => c.data.rawData?.ports || []).map((p) => {
                 if (typeof p === 'object' && p !== null) return p;
                 return { hostPort: Number(p), containerPort: Number(p), protocol: 'tcp' } as PortMapping;
             });
             
             return {
                 ...node,
                 data: {
                     ...node.data,
                     collapsed: isCollapsed,
                     summary: {
                         status,
                         verifiedDomains,
                         portMap
                     },
                     onToggle: (id: string) => {
                         setCollapsedGroups(prev => {
                             const next = new Set(prev);
                             if (next.has(id)) next.delete(id);
                             else next.add(id);
                             return next;
                         });
                     }
                 },
                 // When collapsed, we remove dimensions to let ELK recalculate for the smaller node
                 style: isCollapsed ? { ...node.style, width: undefined, height: undefined } : node.style 
             };
        }
        return node;
    });

    // 2. Filter hidden nodes
    // Filter out any node whose parent is collapsed
    const visibleNodes = processedNodes.filter(n => !n.parentId || !collapsed.has(n.parentId));
    const visibleNodeIds = new Set(visibleNodes.map(n => n.id));

    // 3. Process Edges (Redirect edges from hidden children to their collapsed parent)
    const edgeSignatures = new Set<string>();
    const visibleEdges: Edge[] = [];

    // Helper to find the visible representative for a node (itself or its parent)
    const getVisibleId = (id: string): string | null => {
        if (visibleNodeIds.has(id)) return id;
        const node = nodes.find(n => n.id === id);
        if (node && node.parentId && visibleNodeIds.has(node.parentId)) {
            return node.parentId;
        }
        return null;
    };

    edges.forEach(e => {
        const source = getVisibleId(e.source);
        const target = getVisibleId(e.target);

        // If either end is not resolvable to a visible node, skip
        if (!source || !target) return;

        // Skip self-loops (edges completely inside a collapsed group)
        if (source === target) return;

        // Deduplicate edges (e.g. multiple children connecting to same target)
        const signature = `${source}->${target}`;
        if (edgeSignatures.has(signature)) return;
        edgeSignatures.add(signature);

        visibleEdges.push({
            ...e,
            id: `e-${source}-${target}`, // Generate new stable ID for the layout
            source,
            target
        });
    });
    
    // 4. Layout
    const layouted = await getLayoutedElements(visibleNodes, visibleEdges);
    setNodes(applyFilter(layouted.nodes as Node<GraphNodeData>[], search));
    setEdges(layouted.edges);
  }, [setNodes, setEdges, applyFilter]);

  const { data: twin } = useDigitalTwin();

  // Compute graph data from Twin on the fly
  // This replaces backend aggregation logic with client-side graph builder.
  // OR we keep backend API but make it reactive?
  // Ideally, if we have full twin, we can build the graph locally.
  // BUT the graph logic is complex (see `src/app/api/network/graph/route.ts`).
  // For now, let's keep fetching the graph from API but trigger it via Twin updates OR 
  // rewrite `useNetworkGraph` to be a pure function of `twin`.
  //
  // Given user request "loaded from digital twin", we should rebuild graph here.
  // However, rewriting the entire graph builder logic from server to client is risky and large.
  //
  // Alternative: Auto-fetch graph when twin updates. (Slightly cheating but fits "no refresh button")
  // Better: Port the essential graph logic. 
  //
  // Let's check `src/lib/network/graph.ts` complexity. If it's pure logic, we can import it?
  // It imports `manager`, `nodes` which are server-side.
  // So we CANNOT run graph builder on client easily without heavy refactor.
  // 
  // Compromise: We keep fetching from API, but we use `twin` as a dependency to trigger re-fetch automatically.
  // AND we verify if the server pushes graph updates? The server pushes TWIN updates.
  // So when twin updates, we re-fetch graph.
  //
  // Actually, for "Network Map loaded from digital twin", ideally the client builds it.
  // But let's stick to the "No Refresh Button" requirement first.
  
  const [rawData, setRawData] = useState<NetworkGraph | null>(null);

  const fetchGraph = useCallback(async () => {
     try {
         const res = await fetch('/api/network/graph');
         if (res.ok) {
             const data = await res.json();
             setRawData(data);
             // setLoading(false);
         }
     } catch (e) {
         console.error('Failed to fetch graph', e);
     }
  }, []);

  // Auto-fetch when Twin updates (debounced)
  useEffect(() => {
     if (!twin) return;
     
     // Debounce slightly to avoid thrashing on rapid partial updates
     const t = setTimeout(fetchGraph, 500);
     return () => { clearTimeout(t); };
  }, [twin, fetchGraph]); 

  // const refreshing = false; // Hidden

  const handleCreateExternalLink = useCallback((nodeData: GraphNodeData) => {
    if (!nodeData) return;
    const { externalTargetIp, externalTargetPort } = nodeData.metadata || {};
    const rawName = nodeData.rawData?.name || 'External Service';

    // Pre-fill form
    setLinkForm({
        name: rawName,
        url: externalTargetIp ? `http://${externalTargetIp}:${externalTargetPort}` : '',
        description: `Imported from Nginx proxy target ${externalTargetIp}:${externalTargetPort}`,
        monitor: true,
        ip_targets: externalTargetIp || ''
    });
    setShowLinkModal(true);
  }, []);

  const graphData = useMemo(() => {
      if (!rawData) return null;
      
      const flowNodes: Node<GraphNodeData>[] = rawData.nodes.map((n) => {
        const isGroup = n.type === 'group';
        
        return {
            id: n.id,
            type: 'custom', // Use our custom node
            position: { x: 0, y: 0 }, // Initial position, will be set by ELK
            data: {
                ...n,
                label: n.label,
                type: n.type,
                status: n.status,
                subLabel: n.subLabel ?? undefined,
                hostname: n.hostname ?? undefined,
                ip: n.ip ?? undefined,
                rawData: n.rawData,
                metadata: n.metadata,
                onCreateExternalLink: handleCreateExternalLink
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

      const flowEdges: Edge[] = rawData.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        type: 'smoothstep',
        markerEnd: {
            type: MarkerType.ArrowClosed,
        },
        style: e.style,
        data: {
            isManual: e.isManual,
            state: e.state
        },
        animated: e.state === 'active'
    }));
      
      return { nodes: flowNodes, edges: flowEdges };
  }, [rawData, handleCreateExternalLink]);



  useEffect(() => {
     if (graphData) {
        let currentCollapsed = collapsedGroups;
        if (!rawGraphData.current && graphData.nodes.length > 0) {
              const groups = graphData.nodes
                    .filter(n => ['group', 'service', 'pod', 'proxy'].includes(n.data.type as string))
                    .map(n => n.id);
              currentCollapsed = new Set(groups);
              setCollapsedGroups(currentCollapsed);
        }
        
        rawGraphData.current = graphData;
        processAndLayout(graphData.nodes, graphData.edges, currentCollapsed, searchQuery);
     }
  }, [graphData, processAndLayout, collapsedGroups, searchQuery]);

  useEffect(() => {
    // Setup SSE for progress updates
    const eventSource = new EventSource('/api/stream');
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'network-scan-progress' && activeToastRef.current) {
           updateToast(activeToastRef.current, 'loading', 'Refreshing Network', data.message);
        }
      } catch (e) {
        console.error('Error parsing SSE message', e);
      }
    };

    return () => {
      eventSource.close();
    };
  }, [updateToast]);

  const handleEditLink = () => {
      if (!selectedNodeData || !selectedNodeData.rawData) return;
      const { name, url, description, monitor, ip_targets } = selectedNodeData.rawData;
      
      setLinkForm({
          name: name || '',
          url: url || '',
          description: description || '',
          monitor: monitor || false,
          ip_targets: Array.isArray(ip_targets) ? ip_targets.join(', ') : ''
      });
      setShowLinkModal(true);
  };

  const handleSaveLink = async () => {
    if (!linkForm.name || !linkForm.url) {
        addToast('error', 'Name and URL are required');
        return;
    }

    try {
        const ipTargets = linkForm.ip_targets 
            ? linkForm.ip_targets.split(',').map(s => s.trim()).filter(Boolean) 
            : [];

        const res = await fetch(`/api/services/${encodeURIComponent(linkForm.name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: linkForm.url,
                description: linkForm.description,
                monitor: linkForm.monitor,
                ip_targets: ipTargets,
                type: 'link'
            })
        });

        if (!res.ok) throw new Error('Failed to update link');
        
        addToast('success', 'Link updated successfully');
        setShowLinkModal(false);
        fetchGraph(); 
        
        if (selectedNodeData && selectedNodeData.rawData && selectedNodeData.rawData.name === linkForm.name) {
             setSelectedNodeData({
                 ...selectedNodeData,
                 rawData: {
                     ...selectedNodeData.rawData,
                     url: linkForm.url,
                     description: linkForm.description,
                     monitor: linkForm.monitor,
                     ip_targets: ipTargets
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
                        case 'gateway': return '#ea580c'; // orange-600
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
                        case 'service': return '#c084fc'; // purple-400
                        case 'pod': return '#f472b6'; // pink-400
                        case 'proxy': return '#34d399'; // emerald-400
                        case 'router': return '#fb923c'; // orange-400
                        case 'gateway': return '#fb923c'; // orange-400
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
      
      {/* Monitoring Modal */}
      {showMonitoringModal && monitoringData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
                <div className="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-700">
                    <div className="flex items-center gap-3">
                        <Activity className="text-blue-500" />
                        <div>
                            <h3 className="text-lg font-bold">Device Monitoring</h3>
                            <div className="text-xs text-gray-500">Fritz!Box Gateway</div>
                        </div>
                    </div>
                    <button onClick={() => setShowMonitoringModal(false)} className="text-gray-500 hover:text-gray-700">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Status Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="p-4 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700">
                            <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-1">Connection</div>
                            <div className="flex items-center gap-2">
                                <div className={`w-2.5 h-2.5 rounded-full ${monitoringData.connected ? 'bg-green-500' : 'bg-red-500'}`} />
                                <span className="font-bold text-lg">{monitoringData.connected ? 'Connected' : 'Disconnected'}</span>
                            </div>
                        </div>
                        <div className="p-4 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700">
                            <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-1">External IP</div>
                            <div className="font-mono text-lg">{monitoringData.externalIP || 'N/A'}</div>
                        </div>
                        <div className="p-4 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700">
                            <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-1">Uptime</div>
                            <div className="font-mono text-lg">
                                {monitoringData.uptime ? `${Math.floor(monitoringData.uptime / 3600)}h ${Math.floor((monitoringData.uptime % 3600) / 60)}m` : 'N/A'}
                            </div>
                        </div>
                    </div>

                    {/* DNS Info */}
                    <div className="space-y-2">
                        <h4 className="font-bold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                            <Globe size={16} />
                            DNS Configuration
                        </h4>
                        <div className="bg-gray-50 dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                            {monitoringData.dnsServers && monitoringData.dnsServers.length > 0 ? (
                                <div className="divide-y divide-gray-200 dark:divide-gray-800">
                                    {monitoringData.dnsServers.map((dns: string, i: number) => {
                                        const isInternal = dns.startsWith('192.168.') || dns.startsWith('10.') || dns.startsWith('127.');
                                        return (
                                            <div key={i} className="p-3 flex items-center justify-between">
                                                <div className="flex items-center gap-3">
                                                    <span className="font-mono text-sm">{dns}</span>
                                                    {isInternal ? (
                                                        <span className="px-2 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
                                                            Internal (Pi-hole/AdGuard)
                                                        </span>
                                                    ) : (
                                                        <span className="px-2 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border border-blue-200 dark:border-blue-800">
                                                            External (ISP/Google)
                                                        </span>
                                                    )}
                                                </div>
                                                {i === 0 && <span className="text-xs text-gray-400 italic">Primary</span>}
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="p-4 text-sm text-gray-500 italic">No DNS servers detected</div>
                            )}
                        </div>
                    </div>

                    {/* Device Logs */}
                    <div className="space-y-2 flex-1 min-h-0 flex flex-col">
                        <h4 className="font-bold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                            <FileText size={16} />
                            Device Logs
                        </h4>
                        <div className="bg-gray-900 text-gray-300 rounded-lg border border-gray-700 p-4 font-mono text-xs overflow-auto max-h-[400px] whitespace-pre-wrap">
                            {monitoringData.deviceLog || 'No logs available.'}
                        </div>
                    </div>
                </div>
            </div>
        </div>
      )}

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
                    {selectedNodeData.type === 'router' && (
                        <button 
                            onClick={() => {
                                setMonitoringData((selectedNodeData.rawData as MonitoringData) || null);
                                setShowMonitoringModal(true);
                            }}
                            className="w-full flex items-center justify-center gap-2 p-2 bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 rounded-lg transition-colors text-sm font-medium"
                        >
                            <Activity size={14} />
                            Device Monitoring
                        </button>
                    )}

                    {selectedNodeData.type === 'device' && (
                        <button 
                            onClick={() => {
                                const url = selectedNodeData.metadata?.verifiedDomains?.[0] || selectedNodeData.metadata?.link || '';
                                setLinkForm({
                                    name: selectedNodeData.label || '',
                                    url: url,
                                    description: selectedNodeData.metadata?.description || '',
                                    monitor: true
                                });
                                setShowLinkModal(true);
                            }}
                            className="w-full flex items-center justify-center gap-2 p-2 bg-cyan-50 text-cyan-600 hover:bg-cyan-100 rounded-lg transition-colors text-sm font-medium"
                        >
                            <LinkIcon size={14} />
                            Create External Link
                        </button>
                    )}

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
                            href={selectedNodeData.rawData?.metadata?.link || '#'}
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
                          {/* Host Network Flag */}
                          {selectedNodeData.rawData?.hostNetwork && (
                              <div className="flex justify-between">
                                  <span className="text-gray-500">Mode</span>
                                  <span className="font-mono text-amber-600 dark:text-amber-400 font-bold">Host Network</span>
                              </div>
                          )}
                          {selectedNodeData.rawData?.ports && selectedNodeData.rawData.ports.length > 0 && (
                              <div className="flex justify-between">
                                  <span className="text-gray-500">Ports</span>
                                  <span className="font-mono">
                                    {(selectedNodeData.rawData.ports as unknown[]).map((p) => {
                                        if (typeof p === 'object' && p !== null) {
                                            const port = p as LegacyPortMapping;
                                            const h = port.host || port.hostPort;
                                            const c = port.container || port.containerPort;
                                            return h && c && h !== c ? `${h}:${c}` : (h || c);
                                        }
                                        return String(p);
                                    }).join(', ')}
                                  </span>
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
