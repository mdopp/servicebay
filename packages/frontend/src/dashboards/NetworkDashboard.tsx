'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

import { useTopologyData } from '@/hooks/useTopologyData';
import { NETWORK_FOCUS_PARAM, planDeepLinkFocus } from '@/components/networkFocus';
import type { PortMapping, ServiceUnit } from '@servicebay/api-client';
import { buildServiceViewModel } from '@servicebay/api-client';
import type { ServiceViewModel } from '@servicebay/api-client';
import { useServiceActions } from '@/hooks/useServiceActions';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { DomainHealthDot } from '@/components/DomainHealthDot';
import ServiceDetailSummary from '@/components/serviceDetail/ServiceDetailSummary';

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
import { getLayoutedElements } from '@servicebay/api-client';
import { X, Trash2, Edit, Info, Globe, Search, FileText, Activity, Link as LinkIcon, ChevronDown, LayoutGrid, Plus, ArrowRight, ArrowLeft, Lock } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import { useToast } from '@/providers/ToastProvider';
import ExternalLinkModal from '@/components/ExternalLinkModal';
import { Button, Badge, StatusDot } from '@/components/ui';
import {
  buildOrthogonalPath,
  buildServiceEditHref,
  computeEgoNodeIds,
  DEFAULT_EDGE_COLOR,
  DOWN_EDGE_COLOR,
  DOWN_EDGE_DASHES,
  deriveNodeNameFromGraph,
  labelForEdgeKind,
  mergeGraphPreservingPositions,
  styleForEdgeKind,
  topologyLayoutSignature,
  type GraphNodeData,
  type HealthData,
  type LegacyPortMapping,
} from './_lib/networkDashboard';
import type { ReactFlowInstance } from '@xyflow/react';

// #1782 orthogonal path + #1784 line-hop geometry live in
// ./_lib/networkDashboard (buildOrthogonalPath) so the dashboard stays under
// the file-size invariant and the path math is unit-testable.

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
  data,
}: EdgeProps) => {
  // #1782 — prefer ELK's orthogonal routing points (attached as data.points
  // by getLayoutedElements). Fall back to smoothstep when ELK didn't route
  // this edge (e.g. an edge added before the next layout pass).
  const elkPoints = (data as { points?: { x: number; y: number }[] } | undefined)?.points;
  // #1784 — hop points where this edge's horizontal runs cross a different
  // edge; rendered as ∩ overpasses so a crossing is distinct from a junction.
  const hops = (data as { hops?: { x: number; y: number }[] } | undefined)?.hops ?? [];

  let edgePath: string;
  let labelX: number;
  let labelY: number;

  if (elkPoints && elkPoints.length >= 2) {
    const built = buildOrthogonalPath(elkPoints, hops);
    edgePath = built.path;
    labelX = built.labelX;
    labelY = built.labelY;
  } else {
    [edgePath, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }

  if (!label) {
      return <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />;
  }

  // #1783 — prefer ELK's CENTER-placed label position (data.lpos), which
  // reserves overlap-free space during layout. Fall back to the polyline
  // midpoint when ELK didn't place a label (e.g. edge added before layout).
  const lpos = (data as { lpos?: { x: number; y: number } } | undefined)?.lpos;
  const chipX = lpos?.x ?? labelX;
  const chipY = lpos?.y ?? labelY;

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${chipX}px,${chipY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan bg-surface px-2 py-1 rounded-chip border border-border shadow-sm text-[10px] font-mono text-text-muted text-center z-10"
        >
          {String(label).split('\n').map((line: string, i: number) => (
            <div key={i} className={i === 0 && String(label).includes('\n') ? "font-bold border-b border-border mb-0.5 pb-0.5" : ""}>
                {line}
            </div>
          ))}
        </div>
      </EdgeLabelRenderer>
    </>
  );
};

type CustomNodeType = Node<GraphNodeData>;

// Helper: extract node type info
function getNodeTypeInfo(data: GraphNodeData) {
  const isGroup = data.type === 'group';
  const isExpandable = ['group', 'service', 'pod', 'proxy', 'unmanaged-service'].includes(data.type);
  const effectiveType = ((data.type === 'group' && data.rawData?.type) ? data.rawData.type : data.type) as string;
  const isManagedService = effectiveType === 'service';
  const isUnmanagedService = effectiveType === 'unmanaged-service';
  const isServiceType = isManagedService || isUnmanagedService;
  const isMissing = data.rawData?.type === 'missing';
  const isGateway = data.rawData?.type === 'gateway';
  return { isGroup, isExpandable, effectiveType, isManagedService, isUnmanagedService, isServiceType, isMissing, isGateway };
}

// Custom Node Component
// Exported for the #2194 render test (assert a child leaf fills its ELK slot
// with h-full/overflow-hidden and a group renders at the ELK size). Not part of
// the public dashboard API — the graph mounts it via `nodeTypes`.
export const CustomNode = ({ id, data }: NodeProps<CustomNodeType>) => {
    const isCollapsed = data.collapsed;
    const onToggle = data.onToggle;
    const { isGroup, isExpandable, effectiveType, isManagedService, isUnmanagedService, isServiceType, isMissing, isGateway } = getNodeTypeInfo(data);

  // Decide whether to render as the "Opened Group Frame" or the "Node Card"
  const renderAsExpandedGroup = isExpandable && !isCollapsed;

  const summary = data.summary || {};

  // Ubiquitous-dependency badges (#1785). The backend suppresses the
  // auth/lldap (SSO/forward-auth) and adguard (DNS) hub-spoke edges and
  // stamps these flags on the source node instead, so the map stays planar.
  const behindAuth = data.metadata?.behindAuth === true;
  const usesDns = data.metadata?.usesDns === true;

  const getTypeColors = (): Record<string, string> => ({
    container: 'border-blue-400 dark:border-blue-600 bg-blue-100 dark:bg-blue-900/40',
    service: 'border-purple-400 dark:border-purple-600 bg-purple-100 dark:bg-purple-900/40',
    'unmanaged-service': 'border-amber-400 dark:border-amber-500 bg-amber-50 dark:bg-amber-900/30',
    pod: 'border-pink-400 dark:border-pink-600 bg-pink-100 dark:bg-pink-900/40',
    router: 'border-orange-400 dark:border-orange-600 bg-orange-100 dark:bg-orange-600/60',
    internet: 'border-gray-400 dark:border-gray-600 bg-gray-100 dark:bg-gray-800/60',
    proxy: 'border-emerald-400 dark:border-emerald-600 bg-emerald-100 dark:bg-emerald-900/40',
    gateway: 'border-orange-400 dark:border-orange-600 bg-orange-100 dark:bg-orange-800/50',
    link: 'border-cyan-400 dark:border-cyan-600 bg-cyan-100 dark:bg-cyan-900/40',
    device: 'border-indigo-400 dark:border-indigo-600 bg-indigo-100 dark:bg-indigo-900/40',
  });

  const typeLabels: Record<string, string> = {
      container: 'Container',
    service: 'Managed Service',
    'unmanaged-service': 'Unmanaged Bundle',
      pod: 'Pod',
      router: 'Internet Gateway',
      link: 'External Link',
      proxy: 'Reverse Proxy',
      internet: 'Internet',
      device: 'Network Device'
  };

  const typeColors = getTypeColors();
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
      

      // Helper to normalize port IP (handles 0.0.0.0, localhost)
      const normalizePortIp = (ip: string | null, nodeHost: string | null, nodeData: string | null): string | null => {
        if (!ip) return null;
        if (ip === '0.0.0.0' || ip === '127.0.0.1' || ip === 'localhost') {
          return nodeHost || (nodeData && nodeData !== 'local' && nodeData !== 'Local' ? nodeData : null);
        }
        return ip;
      };

      // Helper to extract IP info from ports
      const extractIpInfo = () => {
        if (!rawPorts || rawPorts.length === 0) return { globalIp: null, portMap: [] };

        const nodeHost = typeof data.metadata?.nodeHost === 'string' ? data.metadata.nodeHost as string : null;
        const nodeDataStr = data.node && data.node !== 'local' && data.node !== 'Local' ? data.node : null;

        const parsedPorts = rawPorts.map((p: unknown) => {
            const isObj = typeof p === 'object' && p !== null;
            let ip: string | null = null;
            let hostPort: number | string | null = null;
            let containerPort: number | string | null = null;

            if (isObj) {
                const portObj = p as LegacyPortMapping;
                ip = portObj.hostIp || portObj.IP || null;
                hostPort = portObj.host || portObj.hostPort || null;
                containerPort = portObj.container || portObj.containerPort || null;
            } else {
                const val = p as unknown as (string | number);
                hostPort = val;
                containerPort = val;
            }

            ip = normalizePortIp(ip, nodeHost, nodeDataStr);
            return { host: hostPort, container: containerPort, ip };
        });

        // Deduplicate ports based on IP and Host Port
        const uniquePortsMap = new Map<string, { host: number|string|null, container: number|string|null, ip: string|null }>();
        parsedPorts.forEach((p: { host: number|string|null, container: number|string|null, ip: string|null }) => {
            const key = `${p.ip || '_'}:${p.host}`;
            if (p.host && !uniquePortsMap.has(key)) {
                uniquePortsMap.set(key, p);
            }
        });

        const dedupedPorts = Array.from(uniquePortsMap.values());
        const uniqueIps = Array.from(new Set(dedupedPorts.map((p) => p.ip).filter(Boolean))) as string[];
        const globalIp = uniqueIps.length === 1 ? uniqueIps[0] : null;

        const sortedPorts = globalIp
          ? dedupedPorts
          : [...dedupedPorts].sort((a, b) => String(a.ip ?? '').localeCompare(String(b.ip ?? '')));

        let prevIp: string | null | undefined;
        const portMap = sortedPorts.map((pp) => {
          const showIp = pp.ip != null && pp.ip !== prevIp;
          prevIp = pp.ip;
          return { ...pp, showIp };
        });

        return { globalIp, portMap };
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

  // Helper to build detail item for container type
  const getContainerDetails = (raw: Record<string, unknown>): DetailItem[] => {
    const items: DetailItem[] = [
      { label: 'Created', value: raw.Created ? new Date((raw.Created as number) * 1000).toLocaleDateString() : null },
      { label: 'Status', value: String(raw.Status || '') },
    ];
    if (raw.hostNetwork) items.push({ label: 'Network', value: 'Host' });
    return items;
  };

  // Helper to build detail items for service/bundle type
  const getServiceDetails = (raw: Record<string, unknown>): DetailItem[] => {
    const items: DetailItem[] = [
      {
        label: 'State',
        value: isManagedService
          ? (raw.active ? 'Active' : 'Inactive')
          : (raw.isRunning ? 'Detected' : 'Stopped')
      }
    ];
    if (isManagedService) {
      items.push({ label: 'Load', value: String(raw.load || '') });
      if (raw.hostNetwork) items.push({ label: 'Network', value: 'Host' });
    } else {
      const bundleSize = Array.isArray(raw.services) ? raw.services.length : Array.isArray(raw.containers) ? raw.containers.length : 0;
      items.push({ label: 'Bundle Size', value: bundleSize || 'Unknown' });
      items.push({ label: 'Severity', value: (String(raw.severity || 'info')).toUpperCase() });
    }
    return items;
  };

  // Helper to build detail items for gateway/router type
  const getGatewayDetails = (raw: Record<string, unknown>): DetailItem[] => {
    const items: DetailItem[] = [
      { label: 'Ext IP', value: String(raw.externalIP || data.metadata?.stats?.externalIP || 'Unknown') },
      { label: 'Int IP', value: String(raw.internalIP || data.metadata?.stats?.internalIP || 'Unknown') },
      { label: 'Uptime', value: raw.uptime ? `${Math.floor((raw.uptime as number) / 3600)}h` : 'N/A', full: true }
    ];
    const dns = (raw.dnsServers as string[] | undefined) || data.metadata?.stats?.dnsServers;
    if (dns && Array.isArray(dns) && dns.length > 0) items.push({ label: 'DNS', value: dns.join(', '), full: true });
    return items;
  };

  // Helper to get display details based on type
  const getDetails = (): DetailItem[] => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (data.rawData || {}) as any;

      if (effectiveType === 'container') return getContainerDetails(raw);
      if (isServiceType) return getServiceDetails(raw);
      if (effectiveType === 'link') return [{ label: 'URL', value: raw.url, full: true }];
      if (effectiveType === 'gateway' || effectiveType === 'router') return getGatewayDetails(raw);
      return [];
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

  // #2194 — a child leaf inside a service group is given a definite ELK-reserved
  // slot height (applyChildSlotHeights). Fill that slot with h-full + clip so the
  // card occupies exactly its column slot and can never overflow into the child
  // below it (the stacked/overlapping symptom). Top-level cards keep h-auto.
  const isChildLeaf = Boolean(data.parentNode) && !isGroup && !renderAsExpandedGroup;
  return (
    <div className={`w-full ${
      (isGroup || renderAsExpandedGroup)
        ? 'h-full'
        : isChildLeaf
          ? 'min-w-[320px] h-full overflow-hidden'
          : 'min-w-[320px] h-auto'
    }`}>
      {/* Handles for connecting */}
      <Handle type="target" position={targetPos} className="!w-3 !h-3 !bg-blue-400" />
      <Handle type="source" position={sourcePos} className="!w-3 !h-3 !bg-blue-400" />
      
      {renderAsExpandedGroup ? (
          /* Render as "Expanded Group Frame" */
         <div className={`w-full h-full rounded-xl border-2 flex flex-col justify-between p-2 pl-2 transition-all group-border ${
             // Explicit Group Stylings to ensure visibility
             isServiceType
                 ? (isUnmanagedService
                     ? 'border-amber-400/50 dark:border-amber-500/50 bg-amber-50/50 dark:bg-amber-900/10'
                     : 'border-purple-400/50 dark:border-purple-500/50 bg-purple-50/50 dark:bg-purple-900/10')
                 : effectiveType === 'pod' ? 'border-pink-400/50 dark:border-pink-500/50 bg-pink-50/50 dark:bg-pink-900/10'
                 : effectiveType === 'proxy' ? 'border-emerald-400/50 dark:border-emerald-500/50 bg-emerald-50/50 dark:bg-emerald-900/10'
                 : 'border-gray-300 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/10'
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
                    isServiceType
                        ? (isUnmanagedService
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-purple-700 dark:text-purple-300')
                        : effectiveType === 'pod' ? 'text-pink-700 dark:text-pink-300'
                        : effectiveType === 'proxy' ? 'text-emerald-700 dark:text-emerald-300'
                        : ''
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
                    {(isServiceType || effectiveType === 'pod') ? (
                        <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-white/50 dark:bg-black/20 border border-black/10 dark:border-white/10 uppercase tracking-wider font-extrabold opacity-80">
                            {effectiveType === 'pod' ? 'Pod' : (isUnmanagedService ? 'Bundle' : 'Service')}
                        </span>
                    ) : null}
                    {data.node && data.node !== 'local' && (
                        <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
                            {data.node}
                        </span>
                    )}
                </div>

                {/* Show Ports for Groups if available (Hide for Services/Pods/Proxies as requested) */}
                {portMap.length > 0 && !['service', 'pod', 'proxy', 'unmanaged-service'].includes(effectiveType) && (
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

                            const showIpInTag = !globalIp && p.ip && p.showIp;

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

                    {/* Ubiquitous-dependency badges (#1785) */}
                    {behindAuth && (
                        <span
                            data-testid="badge-behind-auth"
                            className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                            title="Hinter Authelia/LLDAP (SSO)"
                        >
                            <Lock size={10} /> SSO
                        </span>
                    )}
                    {usesDns && (
                        <span
                            data-testid="badge-uses-dns"
                            className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800"
                            title="DNS über AdGuard"
                        >
                            <Globe size={10} /> DNS
                        </span>
                    )}

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
                  {data.subLabel && !['router', 'service', 'pod', 'proxy', 'unmanaged-service'].includes(effectiveType) && (
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
                            {displayDomains.map((domain: string) => {
                                // Same domain-key normalisation the
                                // Services overview uses: the health
                                // check is registered against the bare
                                // hostname, not the URL form.
                                const bareDomain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
                                const looksLikeDomain = /\./.test(bareDomain);
                                return (
                                    <a
                                        key={domain}
                                        href={domain.startsWith('http') ? domain : `https://${domain}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                        className="flex items-center gap-2 text-xs font-mono text-blue-600 dark:text-blue-400 hover:underline px-1.5 py-1 bg-blue-50 dark:bg-blue-900/20 rounded border border-blue-100 dark:border-blue-800/30 transition-colors"
                                    >
                                        {looksLikeDomain
                                            ? <DomainHealthDot domain={bareDomain} />
                                            : <div className="w-1.5 h-1.5 rounded-full bg-gray-400 shrink-0" />}
                                        <span className="truncate" title={domain}>{domain}</span>
                                    </a>
                                );
                            })}
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
                    <PortTagsList portMap={portMap} globalIp={globalIp} nodeData={data} />
                    
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

// Helper: render port tags for nodes
const PortTagsList = ({ portMap, globalIp, nodeData }: { portMap: Array<{ host: number|string|null, container: number|string|null, ip: string|null, showIp?: boolean }>, globalIp: string | null, nodeData: GraphNodeData }) => {
    if (!portMap.length) return null;

    return (
        <div className="flex flex-wrap gap-1.5 items-center">
            {portMap.map((p, idx) => {
                let hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
                if (p.ip) {
                    hostname = p.ip;
                } else if (nodeData.metadata?.nodeHost && typeof nodeData.metadata.nodeHost === 'string' && nodeData.metadata.nodeHost !== 'localhost') {
                    hostname = nodeData.metadata.nodeHost as string;
                } else if (nodeData.node && nodeData.node !== 'local' && nodeData.node !== 'Local') {
                    hostname = nodeData.node;
                }

                const showIpInTag = !globalIp && p.ip && p.showIp;
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
    );
};

const nodeTypes = {
  custom: CustomNode,
};

const edgeTypes = {
  custom: CustomEdge,
};

// Edge-kind styling constants and helpers moved to
// `./_lib/networkDashboard.ts` in #961's first decomposition step.
// `styleForEdgeKind`, `labelForEdgeKind`, the edge-color tokens, and
// the DOWN/DECLARED/OBSERVED palette all live in that module now.

type LinkFormState = {
    name: string;
    url: string;
    description: string;
    monitor: boolean;
    ipTargetsText?: string;
};

// Helper: get MiniMap color for node type
function getMiniMapNodeColor(type: string): string {
  switch (type) {
    case 'container': return '#60a5fa';
    case 'service': return '#c084fc';
    case 'unmanaged-service': return '#fbbf24';
    case 'pod': return '#f472b6';
    case 'proxy': return '#34d399';
    case 'router': return '#fb923c';
    case 'gateway': return '#fb923c';
    case 'internet': return '#9ca3af';
    case 'link': return '#22d3ee';
    case 'device': return '#818cf8';
    case 'group': return 'transparent';
    default: return '#d1d5db';
  }
}

// Helper: get MiniMap stroke color for node type
function getMiniMapStrokeColor(type: string): string {
  switch (type) {
    case 'container': return '#2563eb';
    case 'service': return '#9333ea';
    case 'unmanaged-service': return '#d97706';
    case 'pod': return '#db2777';
    case 'router': return '#ea580c';
    case 'gateway': return '#ea580c';
    case 'internet': return '#4b5563';
    case 'proxy': return '#059669';
    case 'link': return '#0891b2';
    case 'device': return '#4f46e5';
    case 'group': return '#d1d5db';
    default: return '#9ca3af';
  }
}

// Legend body extracted from NetworkLegend so the panel wrapper stays under
// the max-lines-per-function budget after the #1785 badge rows landed.
function LegendBody() {
    return (
        <div className="px-3 pb-2 space-y-1.5 border-t border-border pt-2">
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-blue-500" /><span>Service / Pod</span></div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-purple-500" /><span>Container</span></div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-orange-500" /><span>Gateway</span></div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-cyan-500" /><span>External Link</span></div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-gray-400" /><span>Group / Node</span></div>
            <div className="border-t border-border pt-1.5 mt-1.5">
                <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-green-500" /><span>Active / Running</span></div>
                <div className="flex items-center gap-2 mt-1"><div className="w-2.5 h-2.5 rounded-full bg-red-500" /><span>Stopped / Error</span></div>
            </div>
            <div className="border-t border-border pt-1.5 mt-1.5 space-y-1">
                <div className="flex items-center gap-2">
                    <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#0ea5e9" strokeWidth="2" /></svg>
                    <span>Observed TCP flow</span>
                </div>
                <div className="flex items-center gap-2">
                    <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#d97706" strokeWidth="2" strokeDasharray="4 4" /></svg>
                    <span>Declared dependency</span>
                </div>
                <div className="flex items-center gap-2">
                    <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="#a855f7" strokeWidth="2" strokeDasharray="2 3" /></svg>
                    <span>Inferred (env / host)</span>
                </div>
            </div>
            {/* Ubiquitous-dependency badges (#1785). Hub-spoke edges to
                auth/LLDAP and AdGuard DNS are collapsed into these node
                badges to keep the map planar. */}
            <div className="border-t border-border pt-1.5 mt-1.5 space-y-1">
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"><Lock size={9} /> SSO</span>
                    <span>Hinter Authelia/LLDAP</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-sky-100 dark:bg-sky-900/40 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-800"><Globe size={9} /> DNS</span>
                    <span>DNS über AdGuard</span>
                </div>
            </div>
        </div>
    );
}

function NetworkLegend() {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <Panel position="bottom-left">
            <div className="bg-surface border border-border rounded-card shadow-sm text-xs">
                <button
                    onClick={() => setIsOpen(!isOpen)}
                    className="px-3 py-1.5 flex items-center gap-1.5 text-text-muted hover:text-text font-medium w-full"
                >
                    <Info size={12} />
                    Legend
                    <ChevronDown size={12} className={`ml-auto transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                {isOpen && <LegendBody />}
            </div>
        </Panel>
    );
}

export default function NetworkDashboard() {
    const router = useRouter();
    const searchParams = useSearchParams();
    // #2108 — `?focus=<service-name>` from the Services list jumps here with a
    // service to centre. We resolve it to a graph node id (handling the remote
    // `<node>:` prefix) once the graph has loaded, and apply each distinct
    // param value exactly once so a manual click / Back doesn't get clobbered
    // on re-render.
    const focusParam = searchParams.get(NETWORK_FOCUS_PARAM);
    const appliedFocusParamRef = useRef<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<GraphNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [searchQuery, setSearchQuery] = useState('');
  // Focus / ego mode (#1786): the id of the node whose neighbourhood the
  // map is reduced to. `null` ⇒ full map. Clicking a node enters focus;
  // clicking the canvas, the Back control, or Esc exits it.
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  const reactFlowInstance = useRef<ReactFlowInstance<Node<GraphNodeData>, Edge> | null>(null);
  const [selectedNodeData, setSelectedNodeData] = useState<GraphNodeData | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const rawGraphData = React.useRef<{ nodes: Node[], edges: Edge[] } | null>(null);
  // #2119 — the topology signature (node ids + edge ids + collapsed set +
  // focus) of the currently laid-out graph, and a snapshot of that laid-out
  // graph. A poll whose signature is unchanged does NOT re-run ELK or reset the
  // viewport — it merges fresh status/health onto the existing positions. We
  // fitView only on the FIRST layout and on a focus change (intentional camera
  // moves), never on a steady-state refresh.
  const layoutSignatureRef = React.useRef<string | null>(null);
  const laidOutGraphRef = React.useRef<{ nodes: Node<GraphNodeData>[]; edges: Edge[] } | null>(null);
  const hasFitViewRef = React.useRef(false);
    // #2195 — `activeToastRef` now only tracks a toast owned by an EXPLICIT
    // network scan (the `network-scan-progress` SSE below opens/updates it).
    // The steady-state twin-driven auto-refresh no longer creates one: a
    // background fetch is silent, so a flurry of status/metric twin updates
    // never stacks a "Refreshing Network" toast and makes the UI restless.
    const activeToastRef = React.useRef<string | null>(null);
    const { addToast, updateToast } = useToast();

  // #2195 — surface a refresh indicator ONLY when the topology actually
  // changed (a full re-layout). It is brief and non-sticky (auto-dismisses),
  // never a duration-0 sticky loop. The in-place status/metric merge path
  // (topology signature unchanged) calls neither of these — it stays silent.
  const NETWORK_UPDATED_TOAST_MS = 2500;
  const notifyTopologyChanged = useCallback(() => {
      // If an explicit scan is showing a loading toast, resolve it in place
      // instead of stacking a second toast on top.
      if (activeToastRef.current) {
          updateToast(activeToastRef.current, 'success', 'Network updated', 'Topology changed', NETWORK_UPDATED_TOAST_MS);
          activeToastRef.current = null;
          return;
      }
      addToast('info', 'Network updated', undefined, NETWORK_UPDATED_TOAST_MS);
  }, [addToast, updateToast]);

  const notifyRefreshError = useCallback((description?: string) => {
      if (activeToastRef.current) {
          updateToast(activeToastRef.current, 'error', 'Network refresh failed', description);
          activeToastRef.current = null;
          return;
      }
      addToast('error', 'Network refresh failed', description);
  }, [addToast, updateToast]);

  // Health Modal State
  const [showHealthModal, setShowHealthModal] = useState(false);
  const [healthData, setHealthData] = useState<HealthData | null>(null);

  // Link Modal State
  const [showLinkModal, setShowLinkModal] = useState(false);
    const [linkForm, setLinkForm] = useState<LinkFormState>({ name: '', url: '', description: '', monitor: false, ipTargetsText: '' });

  // Connection Modal State
  const [showConnectionModal, setShowConnectionModal] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [connectionPort, setConnectionPort] = useState('');
  const [availablePorts, setAvailablePorts] = useState<number[]>([]);
    const selectedEdgeDetails = useMemo(() => {
        if (!selectedEdge) return null;
        return edges.find(edge => edge.id === selectedEdge) || null;
    }, [edges, selectedEdge]);
    const selectedEdgeMeta = selectedEdgeDetails?.data as { isManual?: boolean; state?: string; port?: number } | undefined;

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

  const processAndLayout = useCallback(async (nodes: Node<GraphNodeData>[], edges: Edge[], collapsed: Set<string>, search: string, focus: string | null = null) => {
    // 1. Prepare Nodes (Aggregation & toggles)
     
    const processedNodes = nodes.map(node => {
           if (['group', 'service', 'pod', 'proxy', 'unmanaged-service'].includes(node.data.type)) {
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
                 // Only remove dimensions for actual group containers so card nodes keep auto height
                 style: (isCollapsed && node.data.type === 'group')
                     ? { ...node.style, width: undefined, height: undefined }
                     : node.style
             };
        }
        return node;
    });

    // 2. Filter hidden nodes
    // Filter out any node whose parent is collapsed
    const visibleNodes = processedNodes.map(node => {
        if (node.data?.type === 'proxy' && node.style?.height !== undefined) {
            return {
                ...node,
                style: {
                    ...node.style,
                    height: undefined
                }
            };
        }
        return node;
    }).filter(n => !n.parentId || !collapsed.has(n.parentId));
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

        const originalId = (e.data as { originalId?: string })?.originalId || e.id;

        visibleEdges.push({
            ...e,
            id: `e-${source}-${target}`, // Generate new stable ID for the layout
            source,
            target,
            data: {
                ...e.data,
                originalId
            }
        });
    });
    
    // 3b. Focus / ego mode (#1786). Reduce the visible graph to the
    // focus node's neighbourhood + the Internet→focus path before
    // layout, so ELK lays out only the relevant subgraph (crossing-free)
    // and `fitView` zooms to it. Child nodes of a kept group are kept
    // too so expanded groups don't lose their members.
    let layoutNodes = visibleNodes;
    let layoutEdges = visibleEdges;
    if (focus) {
        const ego = computeEgoNodeIds(visibleNodes, visibleEdges, focus);
        if (ego.size > 0) {
            const keep = (n: Node<GraphNodeData>) => ego.has(n.id) || (n.parentId ? ego.has(n.parentId) : false);
            layoutNodes = visibleNodes.filter(keep);
            const keptIds = new Set(layoutNodes.map(n => n.id));
            layoutEdges = visibleEdges.filter(e => keptIds.has(e.source) && keptIds.has(e.target));
        }
    }

    // 4. Layout
    // #2198 — getLayoutedElements now stamps each child leaf's ELK-computed
    // box (width + height) directly, so the #2194 applyChildSlotHeights
    // band-aid is gone; the child card renders `h-full` to fill that slot.
    const layouted = await getLayoutedElements(layoutNodes, layoutEdges);
    const filteredNodes = applyFilter(layouted.nodes as Node<GraphNodeData>[], search);
    const layoutedEdges = layouted.edges;
    setNodes(filteredNodes);
    setEdges(layoutedEdges);
    // #2119 — snapshot the laid-out graph so a subsequent identical-topology
    // poll can merge fresh status/health onto these positions in-place
    // (no ELK, no viewport reset).
    laidOutGraphRef.current = { nodes: filteredNodes, edges: layoutedEdges };

    // #2119 — fit the viewport only on the FIRST layout (empty → first data)
    // and on a focus change (the #2108 ego-action is an intentional camera
    // move). Steady-state polls never reach here, so the pan/zoom is preserved.
    if (focus) {
        requestAnimationFrame(() => {
            reactFlowInstance.current?.fitView({ padding: 0.2, duration: 400 });
        });
    } else if (!hasFitViewRef.current) {
        hasFitViewRef.current = true;
        requestAnimationFrame(() => {
            reactFlowInstance.current?.fitView({ padding: 0.18, minZoom: 0.7, maxZoom: 1.2 });
        });
    }
  }, [setNodes, setEdges, applyFilter]);

  // #2119 — identical-topology poll path: merge the fresh status/health data
  // onto the already-laid-out positions and re-apply the search filter, without
  // running ELK or touching the viewport. Requires a prior laid-out snapshot.
  const mergeInPlace = useCallback((freshNodes: Node<GraphNodeData>[], freshEdges: Edge[], search: string) => {
      const prev = laidOutGraphRef.current;
      if (!prev) return;
      const merged = mergeGraphPreservingPositions(prev.nodes, prev.edges, freshNodes, freshEdges);
      const filtered = applyFilter(merged.nodes, search);
      laidOutGraphRef.current = { nodes: filtered, edges: merged.edges };
      setNodes(filtered);
      setEdges(merged.edges);
  }, [applyFilter, setNodes, setEdges]);

  // #2119 — run-generation guard: each layout effect bumps this; an async
  // pass only commits its focus/toast if it's still the latest run.
  const layoutRunRef = React.useRef(0);

  // #2119 — apply a fresh topology: merge in place when the signature is
  // unchanged (no ELK, no viewport reset), else re-layout. #2108 — commit the
  // resolved deep-link focus to state from the async callback so Back/Esc
  // reflect it. Extracted from the effect to keep both under the size budget.
  const applyTopology = useCallback(async (
      gd: { nodes: Node<GraphNodeData>[]; edges: Edge[] },
      currentCollapsed: Set<string>,
      currentFocus: string | null,
      signature: string,
      focusPlan: ReturnType<typeof planDeepLinkFocus>,
      runId: number,
  ) => {
      const topologyUnchanged =
          layoutSignatureRef.current === signature && laidOutGraphRef.current !== null;
      const hasFreshDeepLinkFocus = Boolean(focusPlan.appliedParam && focusPlan.nodeId);
      // #2195 — the FIRST layout (no prior signature) is the map appearing, not
      // a change; don't announce it. Only a subsequent topology change (a
      // re-layout with a prior signature) surfaces the brief indicator.
      const isFirstLayout = layoutSignatureRef.current === null;
      const isStale = () => layoutRunRef.current !== runId;
      try {
          if (topologyUnchanged && !hasFreshDeepLinkFocus) {
              // #2195 — background status/metric merge: the map updates in place
              // and stays SILENT (no loading toast, no success toast).
              mergeInPlace(gd.nodes, gd.edges, searchQuery);
              return;
          }
          await processAndLayout(gd.nodes, gd.edges, currentCollapsed, searchQuery, currentFocus);
          layoutSignatureRef.current = signature;
          if (isStale()) return;
          if (focusPlan.appliedParam && focusPlan.nodeId) {
              appliedFocusParamRef.current = focusPlan.appliedParam;
              setFocusNodeId(focusPlan.nodeId);
          }
          // #2195 — a real topology change re-laid the map out: surface a brief,
          // non-sticky indicator (skip the initial appear + deep-link camera move).
          if (!isFirstLayout && !hasFreshDeepLinkFocus) notifyTopologyChanged();
      } catch {
          if (!isStale()) notifyRefreshError('Unable to render network map');
      }
  }, [mergeInPlace, processAndLayout, searchQuery, notifyTopologyChanged, notifyRefreshError, setFocusNodeId]);

  // #1071 phase 1: data layer (graph fetch + twin-driven auto-refresh
  // + the two effects that drive them) is in useTopologyData. Toast
  // plumbing stays here since it's a UI concern.
  const { rawData, fetchGraph, twin } = useTopologyData({
    onLoadError: (message) => notifyRefreshError(message),
  });

  // The service-action overlays (start/stop/restart/delete modals) still mount
  // so deletions triggered elsewhere resolve cleanly; the per-service controls
  // that used to open them moved to the shared ServiceDetailSummary → Operate
  // page (IA slice 1, #2029).
  const { overlays: serviceActionOverlays } = useServiceActions({ onRefresh: fetchGraph });

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
                ipTargetsText: externalTargetIp || ''
    });
    setShowLinkModal(true);
  }, []);

  const graphData = useMemo(() => {
      if (!rawData) return null;
      
      const nodeStatusMap = new Map<string, string | undefined>();
      rawData.nodes.forEach((node) => {
          nodeStatusMap.set(node.id, node.status as string | undefined);
      });

      const coerceStrokeWidth = (value: unknown): number => {
          if (typeof value === 'number' && Number.isFinite(value)) return value;
          if (typeof value === 'string') {
              const parsed = parseFloat(value);
              if (Number.isFinite(parsed)) return parsed;
          }
          return 2;
      };

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
            className: isGroup ? 'border border-dashed border-slate-300 dark:border-white/10 bg-slate-500/[0.02] dark:bg-white/[0.01] rounded-2xl backdrop-blur-[2px]' : undefined,
            // #2201 — React Flow v12 reads layout dims from top-level
            // width/height, not style. Set the initial group guess top-level so
            // it doesn't fight the top-level dims getLayoutedElements stamps.
            ...(isGroup ? { width: 400, height: 200 } : {}),
            style: isGroup ? {
                width: 400, // Initial guess, ELK will resize
                height: 200,
            } : undefined
        };
      });

      const flowEdges: Edge[] = rawData.edges.map((e) => {
        const fallbackLabel = Number.isFinite(e.port) && e.port > 0 ? `:${e.port}` : undefined;
        const targetStatus = nodeStatusMap.get(e.target);
        const connectsToDownNode = targetStatus === 'down';
        const baseStyle = e.style as React.CSSProperties | undefined;
        // Down-target styling (red dashed) takes priority over kind
        // styling — a broken target is more urgent than provenance. (#813)
        const edgeStyle = connectsToDownNode
            ? {
                ...(baseStyle || {}),
                stroke: DOWN_EDGE_COLOR,
                strokeWidth: Math.max(2, coerceStrokeWidth(baseStyle?.strokeWidth)),
                strokeDasharray: DOWN_EDGE_DASHES
            }
            : styleForEdgeKind(e.kind, baseStyle);

        const rawLabel = e.label ?? fallbackLabel;
        const decoratedLabel = labelForEdgeKind(e.kind, rawLabel);

        return {
            id: e.id,
            source: e.source,
            target: e.target,
            label: decoratedLabel,
            // #1782 — `custom` edge renders ELK's orthogonal points (attached
            // by getLayoutedElements) as a 90° polyline; falls back to
            // smoothstep until the layout pass routes it.
            type: 'custom',
            markerEnd: {
                type: MarkerType.ArrowClosed,
            },
            style: edgeStyle,
            data: {
                isManual: e.isManual,
                state: e.state,
                port: e.port,
                kind: e.kind,
                // Provenance text used by the edge inspector / tooltip
                // when the operator clicks a `declared` edge to confirm
                // it's an annotation, not observed traffic. (#813)
                tooltip: e.kind === 'declared'
                    ? 'Declared dependency — not observed traffic'
                    : e.kind === 'observed'
                        ? `Observed TCP flow${Number.isFinite(e.port) && e.port > 0 ? ` to :${e.port}` : ''}`
                        : e.kind === 'inferred'
                            ? 'Inferred from env / host — not observed traffic'
                            : undefined,
            },
            animated: connectsToDownNode ? true : e.state === 'active'
        };
      });
      
      return { nodes: flowNodes, edges: flowEdges };
  }, [rawData, handleCreateExternalLink]);

  // #2108 — apply the `?focus=` deep-link once the graph nodes exist. Resolving
  // against the live node ids handles both local (`service-x`) and remote
  // (`box2:service-x`) forms without the linking page reconstructing the prefix.
  const selectedNodeName = useMemo(() => deriveNodeNameFromGraph(selectedNodeData), [selectedNodeData]);

  const selectedServiceViewModel = useMemo<ServiceViewModel | null>(() => {
      if (!selectedNodeData || selectedNodeData.type !== 'service') return null;
      if (!selectedNodeData.rawData) return null;
      if (!selectedNodeName) return null;
      const nodeState = twin?.nodes?.[selectedNodeName];
      if (!nodeState) return null;

      try {
          return buildServiceViewModel({
              unit: selectedNodeData.rawData as ServiceUnit,
              nodeName: selectedNodeName,
              nodeState,
              installedTemplates: twin?.installedTemplates,
          });
      } catch {
          return null;
      }
  }, [selectedNodeData, selectedNodeName, twin]);



  useEffect(() => {
      if (!graphData) return;

      // currentFocus = the live focus state unless a fresh `?focus=` deep-link
      // resolves below (its setState isn't visible until the next render).
      let currentCollapsed = collapsedGroups;
      let currentFocus = focusNodeId;
      if (!rawGraphData.current && graphData.nodes.length > 0) {
                  const groups = graphData.nodes
                      .filter(n => ['group', 'service', 'pod', 'proxy', 'unmanaged-service'].includes(n.data.type as string))
                      .map(n => n.id);
              currentCollapsed = new Set(groups);
              setCollapsedGroups(currentCollapsed);
      }

      // #2108 — resolve the `?focus=` deep-link to a concrete node id, applied
      // once per distinct param (ref-guard) so a manual click / Back isn't
      // clobbered when this effect re-runs.
      const focusPlan = planDeepLinkFocus(
          graphData.nodes.map(n => n.id),
          focusParam,
          appliedFocusParamRef.current,
      );
      if (focusPlan.clearApplied) appliedFocusParamRef.current = null;
      if (focusPlan.nodeId) currentFocus = focusPlan.nodeId;

      rawGraphData.current = graphData;

      // #2119 — signature folds the node/edge ids + collapsed set + focus
      // (everything that moves POSITIONS); status/health/label are excluded, so
      // a steady-state poll keeps the same signature → merge in place.
      const signature = topologyLayoutSignature(
          graphData.nodes,
          graphData.edges,
          currentCollapsed,
          currentFocus,
      );
      const runId = ++layoutRunRef.current;
      applyTopology(graphData, currentCollapsed, currentFocus, signature, focusPlan, runId);
  }, [graphData, applyTopology, collapsedGroups, focusNodeId, focusParam]);

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

        const closeNodeDetails = useCallback(() => {
            setSelectedNodeData(null);
        }, []);

        const closeEdgeDetails = useCallback(() => {
            setSelectedEdge(null);
        }, []);

        // Exit focus/ego mode (#1786): restore the full map. Used by the
        // Back control, a canvas (pane) click, and Esc.
        const exitFocus = useCallback(() => {
            setFocusNodeId(null);
        }, []);

        useEscapeKey(closeNodeDetails, Boolean(selectedNodeData), true);
        useEscapeKey(closeEdgeDetails, Boolean(selectedEdge), true);
        // Esc exits focus only when no overlay panel is open above it
        // (the panels' own Esc handlers take precedence via topMostOnly).
        useEscapeKey(exitFocus, Boolean(focusNodeId) && !selectedNodeData && !selectedEdge, true);

  const handleEditLink = () => {
      if (!selectedNodeData || !selectedNodeData.rawData) return;
      const { name, url, description, monitor, ipTargets } = selectedNodeData.rawData;
      const targetsArray = Array.isArray(ipTargets) ? ipTargets : [];
      
      setLinkForm({
          name: name || '',
          url: url || '',
          description: description || '',
          monitor: monitor || false,
          ipTargetsText: targetsArray.join(', ')
      });
      setShowLinkModal(true);
  };

  const handleSaveLink = async () => {
    if (!linkForm.name || !linkForm.url) {
        addToast('error', 'Name and URL are required');
        return;
    }

    try {
        const ipTargets = linkForm.ipTargetsText 
            ? linkForm.ipTargetsText.split(',').map(s => s.trim()).filter(Boolean) 
            : [];

        const res = await fetch(`/api/services/${encodeURIComponent(linkForm.name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: linkForm.url,
                description: linkForm.description,
                monitor: linkForm.monitor,
                ipTargets,
                type: 'link'
            })
        });

        if (!res.ok) throw new Error('Failed to update link');
        
        addToast('success', 'Link updated successfully');
        setShowLinkModal(false);
        setLinkForm({ name: '', url: '', description: '', monitor: false, ipTargetsText: '' });
        fetchGraph(); 
        
        if (selectedNodeData && selectedNodeData.rawData && selectedNodeData.rawData.name === linkForm.name) {
             setSelectedNodeData({
                 ...selectedNodeData,
                 rawData: {
                     ...selectedNodeData.rawData,
                     url: linkForm.url,
                     description: linkForm.description,
                     monitor: linkForm.monitor,
                     ipTargets
                 }
             });
        }
    } catch {
        addToast('error', 'Failed to update link');
    }
  };

  const handleNavigateToBundleMigration = useCallback((node: GraphNodeData) => {
      if (!node) return;
      const metadataId = typeof node.metadata?.bundleId === 'string' ? node.metadata.bundleId : undefined;
      const rawId = typeof node.rawData?.id === 'string' ? node.rawData.id : undefined;
      const fallbackId = typeof node.id === 'string' && node.id.includes('bundle-')
          ? node.id.slice(node.id.lastIndexOf('bundle-') + 'bundle-'.length)
          : undefined;
      const bundleId = metadataId || rawId || fallbackId;

      if (!bundleId) {
          addToast('error', 'Unable to locate bundle metadata');
          return;
      }

      const params = new URLSearchParams({ bundle: bundleId });
      const nodeContext = deriveNodeNameFromGraph(node) || selectedNodeName;
      if (nodeContext) {
          params.set('bundleNode', nodeContext);
      }

      setSelectedNodeData(null);
      router.push(`/services?${params.toString()}`);
  }, [addToast, router, selectedNodeName]);

  const handleDeleteEdge = async () => {
      if (!selectedEdge) return;
      const edgeInfo = edges.find(edge => edge.id === selectedEdge);
      if (!(edgeInfo?.data as { isManual?: boolean })?.isManual) {
          addToast('error', 'Only manual connections can be removed');
          return;
      }
      const originalId = (edgeInfo?.data as { originalId?: string })?.originalId || selectedEdge;
      try {
          const res = await fetch(`/api/network/edges?id=${encodeURIComponent(originalId)}`, {
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
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-subtle" />
            <input
                type="text"
                placeholder="Search..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 rounded-card border border-border bg-surface-2 text-text focus:ring-2 focus:ring-accent outline-none text-sm"
            />
        </div>
      </PageHeader>

      <div className="flex-1 bg-surface-muted border-t border-border relative overflow-hidden">
        <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            // #2119 — fitView is driven imperatively (first layout + #2108 focus
            // only). The declarative `fitView` prop refits whenever the node set
            // changes, which would reset the viewport on every poll.
            fitViewOptions={{ padding: 0.18, minZoom: 0.7, maxZoom: 1.2 }}
            minZoom={0.1}
            maxZoom={2}
            defaultEdgeOptions={{
                type: 'custom',
                animated: true,
                style: { stroke: DEFAULT_EDGE_COLOR, strokeWidth: 2 },
            }}
            onInit={(instance) => { reactFlowInstance.current = instance; }}
            onNodeClick={(_, node) => {
                // Click = focus the node's neighbourhood (#1786) AND open
                // its details. Clicking a neighbour re-focuses on it.
                setSelectedNodeData(node.data);
                setSelectedEdge(null);
                setFocusNodeId(node.id);
            }}
            onEdgeClick={(_, edge) => {
                setSelectedEdge(edge.id);
                setSelectedNodeData(null);
            }}
            onPaneClick={() => {
                // Clicking empty canvas exits focus mode back to the full map.
                if (focusNodeId) setFocusNodeId(null);
            }}
        >
            {focusNodeId && (
                <Panel position="top-left">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={exitFocus}
                        data-testid="focus-back"
                        className="shadow-sm"
                        title="Back to full map (Esc)"
                    >
                        <ArrowLeft size={14} />
                        Full map
                    </Button>
                </Panel>
            )}
            <NetworkLegend />
            <Background color="#999" gap={16} size={1} className="opacity-10" />
            <Controls
                showInteractive={false}
                className="!bg-surface !border-border shadow-lg [&>button]:!bg-surface [&>button]:!border-border [&>button]:!text-text [&>button:hover]:!bg-surface-2 [&>button>svg]:!fill-current"
            />
            <MiniMap
                className="!bg-surface !border-border shadow-lg scale-50 origin-bottom-right md:scale-100"
                maskColor="transparent"
                nodeStrokeColor={(n) => getMiniMapStrokeColor(n.data?.type as string)}
                nodeColor={(n) => getMiniMapNodeColor(n.data?.type as string)}
            />
            {/* Status-only legend was here; consolidated into the bottom-left
                NetworkLegend (which already covers shape colours + status
                dots). Two side-by-side legend panels were redundant. */}
        </ReactFlow>

      </div>
      
      {/* Health Modal */}
      {showHealthModal && healthData && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-surface border border-border rounded-panel shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
                <div className="flex justify-between items-center p-4 border-b border-border">
                    <div className="flex items-center gap-3">
                        <Activity className="text-accent" />
                        <div>
                            <h3 className="text-lg font-bold text-text">Device Health</h3>
                            <div className="text-xs text-text-muted">Fritz!Box Gateway</div>
                        </div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setShowHealthModal(false)} aria-label="Close" className="px-2">
                        <X size={20} />
                    </Button>
                </div>

                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {/* Status Cards */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div className="p-4 rounded-card bg-surface-2 border border-border">
                            <div className="text-xs text-text-muted uppercase tracking-wider font-semibold mb-1">Connection</div>
                            <div className="flex items-center gap-2">
                                <StatusDot state={healthData.connected ? 'ok' : 'fail'} />
                                <span className="font-bold text-lg text-text">{healthData.connected ? 'Connected' : 'Disconnected'}</span>
                            </div>
                        </div>
                        <div className="p-4 rounded-card bg-surface-2 border border-border">
                            <div className="text-xs text-text-muted uppercase tracking-wider font-semibold mb-1">External IP</div>
                            <div className="font-mono text-lg text-text">{healthData.externalIP || 'N/A'}</div>
                        </div>
                        <div className="p-4 rounded-card bg-surface-2 border border-border">
                            <div className="text-xs text-text-muted uppercase tracking-wider font-semibold mb-1">Uptime</div>
                            <div className="font-mono text-lg text-text">
                                {healthData.uptime ? `${Math.floor(healthData.uptime / 3600)}h ${Math.floor((healthData.uptime % 3600) / 60)}m` : 'N/A'}
                            </div>
                        </div>
                    </div>

                    {/* DNS Info */}
                    <div className="space-y-2">
                        <h4 className="font-bold text-text-muted flex items-center gap-2">
                            <Globe size={16} />
                            DNS Configuration
                        </h4>
                        <div className="bg-surface-2 rounded-card border border-border overflow-hidden">
                            {healthData.dnsServers && healthData.dnsServers.length > 0 ? (
                                <div className="divide-y divide-border">
                                    {healthData.dnsServers.map((dns: string, i: number) => {
                                        const isInternal = dns.startsWith('192.168.') || dns.startsWith('10.') || dns.startsWith('127.');
                                        return (
                                            <div key={i} className="p-3 flex items-center justify-between">
                                                <div className="flex items-center gap-3">
                                                    <span className="font-mono text-sm text-text">{dns}</span>
                                                    {isInternal ? (
                                                        <Badge variant="warn" className="text-[10px]">
                                                            Internal (Pi-hole/AdGuard)
                                                        </Badge>
                                                    ) : (
                                                        <Badge variant="info" className="text-[10px]">
                                                            External (ISP/Google)
                                                        </Badge>
                                                    )}
                                                </div>
                                                {i === 0 && <span className="text-xs text-text-subtle italic">Primary</span>}
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="p-4 text-sm text-text-subtle italic">No DNS servers detected</div>
                            )}
                        </div>
                    </div>

                    {/* Device Logs — intentional dark terminal console (raw
                        literal kept by design, consistent with the logs cluster
                        ContainerLogsPanel body). */}
                    <div className="space-y-2 flex-1 min-h-0 flex flex-col">
                        <h4 className="font-bold text-text-muted flex items-center gap-2">
                            <FileText size={16} />
                            Device Logs
                        </h4>
                        <div className="bg-gray-950 text-gray-300 rounded-card border border-gray-800 p-4 font-mono text-xs overflow-auto max-h-[400px] whitespace-pre-wrap">
                            {healthData.deviceLog || 'No logs available.'}
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
            <div className="bg-surface border border-border rounded-panel shadow-xl p-6 w-96 max-w-full m-4">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-bold text-text">Create Connection</h3>
                    <Button variant="ghost" size="sm" onClick={() => setShowConnectionModal(false)} aria-label="Close" className="px-2">
                        <X size={20} />
                    </Button>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-text-muted mb-2">
                            Target Port
                        </label>

                        {availablePorts.length > 0 && (
                            <div className="space-y-2 mb-3">
                                {availablePorts.map(port => (
                                    <label key={port} className="flex items-center gap-2 cursor-pointer p-2 rounded-card hover:bg-surface-2 border border-transparent hover:border-border">
                                        <input
                                            type="radio"
                                            name="targetPort"
                                            value={port}
                                            checked={connectionPort === port.toString()}
                                            onChange={(e) => setConnectionPort(e.target.value)}
                                            className="text-accent focus:ring-accent"
                                        />
                                        <span className="text-sm font-mono text-text">:{port}</span>
                                    </label>
                                ))}
                                <label className="flex items-center gap-2 cursor-pointer p-2 rounded-card hover:bg-surface-2 border border-transparent hover:border-border">
                                    <input
                                        type="radio"
                                        name="targetPort"
                                        value="custom"
                                        checked={!availablePorts.includes(parseInt(connectionPort))}
                                        onChange={() => setConnectionPort('')}
                                        className="text-accent focus:ring-accent"
                                    />
                                    <span className="text-sm text-text">Other</span>
                                </label>
                            </div>
                        )}

                        {(!availablePorts.length || !availablePorts.includes(parseInt(connectionPort))) && (
                             <input
                                type="number"
                                value={connectionPort}
                                onChange={(e) => setConnectionPort(e.target.value)}
                                placeholder="e.g. 8080"
                                className="w-full px-3 py-2 border border-border rounded-card bg-surface-2 text-text focus:ring-2 focus:ring-accent outline-none"
                                autoFocus={!availablePorts.length}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveConnection();
                                }}
                            />
                        )}

                        <p className="text-xs text-text-subtle mt-1">
                            {availablePorts.length > 0 ? 'Select a known port or enter a custom one.' : 'Enter the target port for this connection.'}
                        </p>
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <Button variant="ghost" onClick={() => setShowConnectionModal(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleSaveConnection}>
                            Create Link
                        </Button>
                    </div>
                </div>
            </div>
        </div>
      )}

      {/* IA slice 1 (#2029): the network map's bespoke per-service controls
          (service-action overlays + per-container logs/terminal drawer) were
          only reachable from the old sidebar's ServiceActionBar /
          AttachedContainerList, which the shared ServiceDetailSummary replaced.
          Those actions now live on the linked per-service Operate page, so there
          is one source of truth. */}
      {serviceActionOverlays}

      {/* Context Menu / Details Panel */}
      {selectedNodeData && (
          <div className="fixed inset-0 z-50 flex justify-end bg-gray-950/60 backdrop-blur-sm">
              <div className="w-full sm:max-w-md h-full bg-surface border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right-10">
                  <div className="flex items-start justify-between px-5 py-4 border-b border-border gap-3">
                      <div className="min-w-0 flex-1">
                          <p className="text-xs uppercase font-semibold tracking-[0.2em] text-text-subtle">Node Details</p>
                          <h3 className="font-bold text-xl truncate text-text" title={selectedNodeData.label}>{selectedNodeData.label}</h3>
                          <div className="text-xs text-text-muted font-mono truncate" title={selectedNodeData.id}>{selectedNodeData.id}</div>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedNodeData(null)} aria-label="Close" className="px-2 shrink-0">
                          <X size={16} />
                      </Button>
                  </div>
                  <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                      <div className="flex items-center justify-between p-3 bg-surface-2 rounded-card">
                          <span className="text-sm text-text-muted">Status</span>
                          <Badge variant={selectedNodeData.status === 'up' ? 'ok' : 'fail'}>
                              {selectedNodeData.status?.toUpperCase() || 'UNKNOWN'}
                          </Badge>
                      </div>

                      {/* Actions */}
                      <div className="grid grid-cols-1 gap-2">
                        {selectedNodeData.type === 'router' && (
                            <Button
                                variant="secondary"
                                onClick={() => {
                                    setHealthData((selectedNodeData.rawData as HealthData) || null);
                                    setShowHealthModal(true);
                                }}
                                className="w-full"
                            >
                                <Activity size={14} />
                                Device Health
                            </Button>
                        )}

                        {selectedNodeData.type === 'device' && (
                            <Button
                                variant="secondary"
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
                                className="w-full"
                            >
                                <LinkIcon size={14} />
                                Create External Link
                            </Button>
                        )}

                        {selectedNodeData.type === 'unmanaged-service' && (
                            <Button
                                variant="secondary"
                                onClick={() => handleNavigateToBundleMigration(selectedNodeData)}
                                className="w-full"
                            >
                                <ArrowRight size={14} />
                                Migrate Bundle
                            </Button>
                        )}

                        {selectedNodeData.type === 'link' && (
                            <Button
                                variant="secondary"
                                onClick={handleEditLink}
                                className="w-full"
                            >
                                <Edit size={14} />
                                Edit Link
                            </Button>
                        )}

                        {selectedNodeData.type === 'container' && selectedNodeData.rawData?.Id && (
                            <Link
                                href={`/status?tab=containers&containerId=${selectedNodeData.rawData.Id}`}
                                className="w-full flex items-center justify-center gap-2 h-10 px-space-4 bg-surface-2 text-text border border-border hover:bg-surface-muted hover:border-border-strong rounded-card transition-colors text-sm font-medium"
                            >
                                <Info size={14} />
                                Inspect Container
                            </Link>
                        )}

                        {selectedNodeData && selectedNodeData.type === 'service' && typeof selectedNodeData.rawData?.name === 'string' && !selectedNodeData.metadata?.isMissingService && (
                            <Link
                                href={buildServiceEditHref(selectedNodeData)}
                                className="w-full flex items-center justify-center gap-2 h-10 px-space-4 bg-surface-2 text-text border border-border hover:bg-surface-muted hover:border-border-strong rounded-card transition-colors text-sm font-medium"
                            >
                                <Edit size={14} />
                                Edit Service
                            </Link>
                        )}

                        {selectedNodeData?.metadata?.isMissingService && (
                            <div className="p-3 rounded-card bg-status-warn/10 border border-status-warn/20 text-xs text-status-warn space-y-1">
                                <div className="font-semibold">No matching service found</div>
                                <div>
                                    Nginx forwards traffic to <span className="font-mono">{(selectedNodeData.metadata.targetUrl as string) || selectedNodeData.label}</span>, but no managed container or service is listening on that port. The most common causes: a stale proxy route from a removed/renamed service, or a service that crashed before it could bind.
                                </div>
                                <div>
                                    Fix it by editing or deleting the route in <span className="font-mono">Settings → Reverse Proxy</span> (or directly in NPM admin).
                                </div>
                            </div>
                        )}

                        {selectedNodeData.type === 'proxy' && (
                            <Link
                                href="/proxy"
                                className="w-full flex items-center justify-center gap-2 h-10 px-space-4 bg-surface-2 text-text border border-border hover:bg-surface-muted hover:border-border-strong rounded-card transition-colors text-sm font-medium"
                            >
                                <Edit size={14} />
                                Configure Proxy
                            </Link>
                        )}

                        {selectedNodeData.rawData?.metadata?.link && (
                            <Link
                                href={selectedNodeData.rawData?.metadata?.link || '#'}
                                target="_blank"
                                className="flex items-center justify-center w-full text-center h-10 px-space-4 bg-accent text-on-accent hover:bg-accent-strong rounded-card transition-colors text-sm font-medium"
                            >
                                Open Service ↗
                            </Link>
                        )}
                      </div>

                      {/* IA slice 1 (#2029, spec §4.2): the per-service detail is
                          the ONE shared ServiceDetailSummary — identical to the
                          Operate page header — so the map sidebar can no longer
                          drift from the rest of the UI. The old bespoke
                          ServiceActionBar + AttachedContainerList panel is gone;
                          full lifecycle + per-container logs/shell live on the
                          linked Operate page (status + health + settings +
                          containers + actions). */}
                      {selectedServiceViewModel && (
                          <div className="border border-border rounded-card p-3">
                              <ServiceDetailSummary service={selectedServiceViewModel} />
                          </div>
                      )}

                      {/* Network Info */}
                      <div className="border-t border-border pt-3">
                          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Network Details</h4>
                          <div className="space-y-1 text-sm">
                              {selectedNodeData.ip && (
                                  <div className="flex justify-between">
                                      <span className="text-text-muted">IP Address</span>
                                      <span className="font-mono text-text">{selectedNodeData.ip}</span>
                                  </div>
                              )}
                              {/* Host Network Flag */}
                              {selectedNodeData.rawData?.hostNetwork && (
                                  <div className="flex justify-between">
                                      <span className="text-text-muted">Mode</span>
                                      <span className="font-mono text-status-warn font-bold">Host Network</span>
                                  </div>
                              )}
                              {selectedNodeData.rawData?.ports && selectedNodeData.rawData.ports.length > 0 && (
                                  <div className="flex justify-between">
                                      <span className="text-text-muted">Ports</span>
                                      <span className="font-mono text-text">
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
                                      <span className="text-text-muted">MAC</span>
                                      <span className="font-mono text-text">{selectedNodeData.rawData.MacAddress}</span>
                                  </div>
                              )}
                          </div>
                      </div>

                      {/* Debug Info */}
                      <div className="border-t border-border pt-3">
                          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Debug Info</h4>
                          <div className="space-y-1 text-xs font-mono text-text-muted">
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
                      <div className="border-t border-border pt-3 pb-2">
                          <h4 className="text-xs font-bold text-text-muted uppercase tracking-wider mb-2">Raw Data</h4>
                          <div className="bg-surface-muted p-2 rounded-card overflow-x-auto">
                              <pre className="text-[10px] font-mono text-text-muted whitespace-pre-wrap break-all">
                                  {JSON.stringify(selectedNodeData.rawData, null, 2)}
                              </pre>
                          </div>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {selectedEdge && (
          <div className="fixed inset-0 z-40 flex justify-end bg-gray-950/60 backdrop-blur-sm">
              <div className="w-full sm:max-w-sm h-full bg-surface border-l border-border shadow-2xl flex flex-col animate-in slide-in-from-right-10">
                  <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                      <div>
                          <p className="text-xs uppercase font-semibold tracking-[0.2em] text-text-subtle">Connection</p>
                          <h3 className="font-bold text-text">Link Details</h3>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => setSelectedEdge(null)} aria-label="Close" className="px-2">
                          <X size={16} />
                      </Button>
                  </div>
                  <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                      <p className="text-sm text-text-muted">
                          {selectedEdgeMeta?.isManual
                              ? 'Manual connection between nodes.'
                              : 'Auto-discovered link inferred from real traffic.'}
                      </p>
                      <div className="space-y-2 text-xs font-mono text-text-muted">
                          <div className="flex justify-between">
                              <span>Port</span>
                              <span>{selectedEdgeMeta?.port ? `:${selectedEdgeMeta.port}` : 'unassigned'}</span>
                          </div>
                          <div className="flex justify-between">
                              <span>Status</span>
                              <span className="uppercase">{selectedEdgeMeta?.state || 'UNKNOWN'}</span>
                          </div>
                      </div>
                      {selectedEdgeMeta?.isManual ? (
                          <Button
                              variant="danger"
                              onClick={handleDeleteEdge}
                              className="w-full"
                          >
                              <Trash2 size={14} />
                              Remove Connection
                          </Button>
                      ) : (
                          <p className="text-xs text-text-muted">
                              Auto-discovered edges cannot be removed manually.
                          </p>
                      )}
                  </div>
              </div>
          </div>
      )}
    </div>
  );
}
