'use client';

/**
 * The graph's custom node renderer — the card/group frame, its badges, the
 * detail grid and the port tags. Lifted verbatim out of NetworkDashboard.tsx
 * (#2743); `CustomNode` is mounted by the dashboard through `nodeTypes`.
 */
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { Globe, ChevronDown, LayoutGrid, Plus, Lock } from 'lucide-react';
import { Button } from '@/components/ui';
import { DomainHealthDot } from '@/components/DomainHealthDot';
import type { GraphNodeData, LegacyPortMapping } from './networkDashboard';

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
    const { isGroup, isExpandable, effectiveType, isManagedService, isUnmanagedService, isServiceType, isMissing } = getNodeTypeInfo(data);

  // Decide whether to render as the "Opened Group Frame" or the "Node Card"
  const renderAsExpandedGroup = isExpandable && !isCollapsed;

  const summary = data.summary || {};

  // Ubiquitous-dependency badges (#1785). The backend suppresses the
  // auth/lldap (SSO/forward-auth) and adguard (DNS) hub-spoke edges and
  // stamps these flags on the source node instead, so the map stays planar.
  const behindAuth = data.metadata?.behindAuth === true;
  const usesDns = data.metadata?.usesDns === true;

  const getTypeColors = (): Record<string, string> => ({
    container: 'border-border bg-surface-2',
    service: 'border-border bg-surface-2',
    'unmanaged-service': 'border-border bg-surface-2',
    pod: 'border-border bg-surface-2',
    router: 'border-border bg-surface-2',
    internet: 'border-border bg-surface-2',
    proxy: 'border-border bg-surface-2',
    gateway: 'border-border bg-surface-2',
    link: 'border-border bg-surface-2',
    device: 'border-border bg-surface-2',
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
      ? 'border-border bg-surface-muted border-dashed'
      : (typeColors[effectiveType] || 'border-border bg-surface');

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
  // Extract helper: get DNS servers from raw or metadata
  const getDnsItem = (raw: Record<string, unknown>): DetailItem | null => {
    const dns = (raw.dnsServers as string[] | undefined) || data.metadata?.stats?.dnsServers;
    if (dns && Array.isArray(dns) && dns.length > 0) {
      return { label: 'DNS', value: dns.join(', '), full: true };
    }
    return null;
  };

  const getGatewayDetails = (raw: Record<string, unknown>): DetailItem[] => {
    const items: DetailItem[] = [
      { label: 'Ext IP', value: String(raw.externalIP || data.metadata?.stats?.externalIP || 'Unknown') },
      { label: 'Int IP', value: String(raw.internalIP || data.metadata?.stats?.internalIP || 'Unknown') },
      { label: 'Uptime', value: raw.uptime ? `${Math.floor((raw.uptime as number) / 3600)}h` : 'N/A', full: true }
    ];
    const dnsItem = getDnsItem(raw);
    if (dnsItem) items.push(dnsItem);
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
        <div className="flex flex-col items-center justify-center w-32 h-32 rounded-full bg-surface-2 border-4 border-border shadow-lg relative group">
            <Handle type="source" position={Position.Right} className="!w-3 !h-3 !bg-accent !-right-1.5" />
            <Globe className="w-12 h-12 text-accent mb-1" />
            <span className="font-bold text-sm text-accent uppercase tracking-wider">Internet</span>
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
      <Handle type="target" position={targetPos} className="!w-3 !h-3 !bg-accent" />
      <Handle type="source" position={sourcePos} className="!w-3 !h-3 !bg-accent" />
      
      {renderAsExpandedGroup ? (
          /* Render as "Expanded Group Frame" */
         <div className={`w-full h-full rounded-xl border-2 flex flex-col justify-between p-2 pl-2 transition-all group-border border-border/50 bg-surface-2/30`}>
            <div className="flex justify-between items-start w-full pointer-events-none">
                <div className={`self-start px-3 py-1.5 rounded-md text-sm font-bold uppercase tracking-wider border shadow-sm flex items-center gap-2 pointer-events-auto bg-surface-2 text-text border-border`}>
                    <Button
                        variant="ghost"
                        onClick={(e) => { e.stopPropagation(); onToggle?.(id); }}
                        className="!h-auto !p-0.5 mr-1 text-muted hover:bg-border"
                        title="Collapse Group"
                    >
                        <LayoutGrid size={14} />
                    </Button>
                    {data.status && (
                        <div className={`w-2.5 h-2.5 rounded-full ${data.status === 'up' ? 'bg-status-ok' : 'bg-status-fail'}`} />
                    )}
                    {data.label}
                    {/* Visual Tag for Pod/Service */}
                    {(isServiceType || effectiveType === 'pod') ? (
                        <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-surface border border-border uppercase tracking-wider font-extrabold opacity-80">
                            {effectiveType === 'pod' ? 'Pod' : (isUnmanagedService ? 'Bundle' : 'Service')}
                        </span>
                    ) : null}
                    {data.node && data.node !== 'local' && (
                        <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] bg-surface-2 text-text border border-border">
                            {data.node}
                        </span>
                    )}
                </div>

                {/* Show Ports for Groups if available (Hide for Services/Pods/Proxies as requested) */}
                {portMap.length > 0 && !['service', 'pod', 'proxy', 'unmanaged-service'].includes(effectiveType) && (
                    <div className="flex flex-col gap-1 items-end">
                        {globalIp && (
                             <div className="text-[10px] font-mono text-muted bg-surface-2 px-1.5 py-0.5 rounded border border-border mb-0.5 self-end" title="Host IP">
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
                                <div key={idx} className="px-2 py-0.5 rounded text-[10px] font-mono bg-surface-2 text-text border border-border shadow-sm flex items-center gap-1">
                                    <a
                                        href={`http://${hostname}:${p.host}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="hover:text-accent hover:underline"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {showIpInTag ? `${p.ip}:${p.host}` : `:${p.host}`}
                                    </a>
                                    {p.container && (
                                        <span className="text-muted">
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
            <div className="flex items-center justify-between border-b border-border pb-2">
                <div className="font-bold text-lg text-text truncate pr-2 flex items-center gap-2" title={data.label}>
                    {/* Add Expand Button if Expandable & Collapsed */}
                    {isExpandable && (
                        <Button
                            variant="ghost"
                            onClick={(e) => { e.stopPropagation(); onToggle?.(id); }}
                            className="!h-auto !p-1 text-muted hover:bg-border transition-colors"
                            title="Expand Group"
                        >
                            <ChevronDown size={16} className="-rotate-90" />
                        </Button>
                    )}
                    
                    {data.label}

                    {/* Ubiquitous-dependency badges (#1785) */}
                    {behindAuth && (
                        <span
                            data-testid="badge-behind-auth"
                            className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-surface-2 text-text border border-border"
                            title="Hinter Authelia/LLDAP (SSO)"
                        >
                            <Lock size={10} /> SSO
                        </span>
                    )}
                    {usesDns && (
                        <span
                            data-testid="badge-uses-dns"
                            className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-surface-2 text-text border border-border"
                            title="DNS über AdGuard"
                        >
                            <Globe size={10} /> DNS
                        </span>
                    )}

                    {/* Host IP moved to Header */}
                    {globalIp && (
                         <div className="text-[10px] font-mono font-bold text-muted bg-surface-2 px-1.5 py-0.5 rounded border border-border ml-1" title="Host IP">
                            {globalIp}
                         </div>
                    )}
                </div>
                {data.status && (
                    <div className={`w-3 h-3 rounded-full shrink-0 ${data.status === 'up' ? 'bg-status-ok' : 'bg-status-fail'}`} />
                )}
            </div>
            
            <div className="flex-1 flex flex-col gap-2 min-h-0">
                <div className="flex gap-2">
                  {data.subLabel && !['router', 'service', 'pod', 'proxy', 'unmanaged-service'].includes(effectiveType) && (
                      <div className="text-xs text-muted font-mono bg-surface px-2 py-1 rounded break-all" title={data.subLabel}>
                          {data.subLabel}
                      </div>
                  )}
                  {!!data.metadata?.pod && (typeof data.metadata.pod === 'string' || typeof data.metadata.pod === 'number') && (
                     <div className="text-xs text-text font-mono bg-surface-2 border border-border px-2 py-1 rounded break-all flex items-center gap-1">
                        <span className="opacity-50 text-[10px]">POD:</span> {data.metadata.pod as React.ReactNode}
                     </div>
                  )}
                </div>

                {/* Dynamic Details Grid */}
                {details.length > 0 && (
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                        {details.map((d, i) => d.value && (
                            <div key={i} className={`flex flex-col min-w-0 ${d.full ? 'col-span-2' : ''}`}>
                                <span className="text-[10px] text-muted uppercase tracking-wider font-semibold">{d.label}</span>
                                {d.label === 'URL' ? (
                                    <a
                                        href={String(d.value)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-sm text-accent font-medium break-words hover:underline"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {d.value}
                                    </a>
                                ) : (
                                    <span className="text-sm text-text font-medium break-words" title={String(d.value)}>{d.value}</span>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {/* Verified Domains List (Filtered for Proxies/Services) */}
                {displayDomains.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border">
                        <span className="text-[10px] text-muted uppercase tracking-wider font-semibold block mb-1">
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
                                        className="flex items-center gap-2 text-xs font-mono text-accent hover:underline px-1.5 py-1 bg-surface-2 rounded border border-border transition-colors"
                                    >
                                        {looksLikeDomain
                                            ? <DomainHealthDot domain={bareDomain} />
                                            : <div className="w-1.5 h-1.5 rounded-full bg-border shrink-0" />}
                                        <span className="truncate" title={domain}>{domain}</span>
                                    </a>
                                );
                            })}
                        </div>
                    </div>
                )}

                {data.hostname && (
                    <div className="text-xs text-muted font-mono bg-surface px-2 py-1 rounded break-all flex items-center gap-1" title="Hostname">
                        <Globe size={10} className="opacity-50" />
                        {data.hostname}
                    </div>
                )}

                {data.metadata?.description && data.type !== 'link' && (
                    <div className="text-xs text-muted line-clamp-2 mt-1 italic" title={data.metadata.description}>
                        {data.metadata.description}
                    </div>
                )}
                
                <div className="mt-auto pt-3 flex items-center justify-between border-t border-border">
                    <PortTagsList portMap={portMap} globalIp={globalIp} nodeData={data} />

                    <div className="flex flex-col items-end gap-1 ml-auto">
                        {data.node && data.node !== 'local' && (!data.parentNode || data.type === 'link') && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-surface-2 text-text border border-border uppercase tracking-wider font-bold">
                                {data.node}
                            </span>
                        )}

                        <span className="text-[10px] font-semibold px-2 py-0.5 bg-surface-2 text-muted rounded border border-border uppercase tracking-wider whitespace-nowrap">
                            {isMissing ? 'Missing Node' : (typeLabels[effectiveType] || effectiveType)}
                        </span>
                        
                        {!!data.metadata?.isExternalMissing && (
                            <Button
                                variant="primary"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    data.onCreateExternalLink?.(data);
                                }}
                                className="!h-auto !px-2 !py-1 mt-1 text-[10px] font-bold uppercase tracking-wider shadow-sm flex items-center gap-1"
                            >
                                <Plus size={10} />
                                Add Link
                            </Button>
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
                    <span className="text-[11px] font-medium px-2 py-0.5 bg-surface-2 text-accent rounded border border-border hover:bg-surface transition-colors cursor-pointer flex items-center gap-1">
                        <span>{showIpInTag ? `${p.ip}:${p.host}` : `:${p.host}`}</span>
                        {p.container && <span className="text-muted opacity-75">(to :{p.container})</span>}
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

