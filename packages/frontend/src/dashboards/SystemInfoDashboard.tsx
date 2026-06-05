'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { getSystemUpdates } from '@/app/actions/system';
import { logger } from '@servicebay/api-client';
import { RefreshCw, Cpu, HardDrive, Network, Server, Package, Copy, Check, Info, Monitor, Settings, AlertTriangle, ShieldCheck } from 'lucide-react';
import { summarizeDnsResolvers, type DnsResolverLabel } from '@/dashboards/_lib/dnsResolvers';
import { useToast } from '@/providers/ToastProvider';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import { useSocket } from '@/hooks/useSocket';
import SectionLoading from '@/components/SectionLoading';
import { getNodes } from '@/app/actions/nodes';
import { PodmanConnection } from '@servicebay/api-client';
import { Select, SelectOption } from '@/components/Select';

interface UpdateInfo {
    count: number;
    list: string[];
}

interface DiskInfo {
    /** the kernel device path, e.g. `/dev/nvme0n1p3` or `/dev/md0`. Surfaces in the row's subline */
    device?: string;
    /** the mount path, e.g. `/var/mnt/data`. Operator-visible primary label */
    mountpoint: string;
    /** filesystem type, e.g. `xfs`, `ext4`, `btrfs` */
    type: string;
    total: number;
    used: number;
}

/**
 * Human-readable label for what a mount is FOR — derived from the
 * mountpoint path. Operators looking at the dashboard want "Data
 * (RAID)" or "OS root" more than the bare path. Falls back to "" so
 * the path itself is the only label if we can't classify.
 */
function describeMountRole(mountpoint: string): string {
    if (!mountpoint) return '';
    if (mountpoint === '/') return 'OS root';
    if (mountpoint === '/sysroot') return 'OS sysroot';
    if (mountpoint === '/boot' || mountpoint === '/boot/efi') return 'Boot';
    if (mountpoint === '/var') return 'OS state';
    if (mountpoint === '/var/mnt/data' || mountpoint === '/mnt/data') return 'Data (RAID)';
    if (mountpoint.startsWith('/var/home/')) return 'Home';
    return '';
}

interface NetworkAddr {
    internal: boolean;
    family: string;
    address: string;
}

// Helper: format bytes to human-readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * SystemInfoContent
 * Core system info display (CPU, RAM, Disk, Network, Updates).
 * Used as a tab inside HealthDashboard.
 */
export function SystemInfoContent() {
  const [copied, setCopied] = useState(false);
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  // Initialize with consistent default for SSR
  const [selectedNode, setSelectedNode] = useState<string>('Local');
  const [updates, setUpdates] = useState<UpdateInfo | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const { addToast } = useToast();

  const { data: twin } = useDigitalTwin();
  const { socket } = useSocket();

  // Load available nodes
  useEffect(() => {
        getNodes()
            .then(setNodes)
            .catch(e => logger.error('SystemInfoDashboard', 'Failed to fetch nodes', e));
    }, []);

  // High Frequency Monitoring Subscription
  useEffect(() => {
    if (!socket || !selectedNode) return;
    
    // Request High-Frequency Resource Mode from Agent
    socket.emit('monitor:resources:start', { node: selectedNode });
    
    return () => {
        socket.emit('monitor:resources:stop', { node: selectedNode });
    };
  }, [socket, selectedNode]);

  // Fetch updates separately
  useEffect(() => {
      let mounted = true;
      const loadUpdates = async () => {
          setCheckingUpdates(true);
          try {
            const up = await getSystemUpdates(selectedNode);
            if (mounted) setUpdates(up);
          } catch (e) {
              logger.error('SystemInfoDashboard', 'Failed to check updates', e);
          } finally {
              if (mounted) setCheckingUpdates(false);
          }
      };
      loadUpdates();
      return () => { mounted = false; };
  }, [selectedNode]);

    const handleCopyCommand = () => {
    navigator.clipboard.writeText('sudo apt update && sudo apt upgrade -y');
    setCopied(true);
    addToast('success', 'Copied to clipboard', 'Update command copied.');
    setTimeout(() => setCopied(false), 2000);
  };

    const handleSelectNode = (value: string) => {
        setSelectedNode(value);
    };

    const nodeOptions = useMemo<SelectOption[]>(() => {
        // Filter out any "Local" from nodes list to avoid duplicates
        const remote = nodes
            .filter(node => node.Name.toLowerCase() !== 'local')
            .map(node => ({
                label: node.Name,
                value: node.Name,
                description: node.URI,
                badge: node.Default ? 'Default' : undefined,
                icon: <Server size={16} className="text-blue-600 dark:text-blue-300" />
            }));
        return [
            {
                label: 'Local',
                value: 'Local',
                description: 'This ServiceBay host',
                icon: <Monitor size={16} className="text-indigo-600 dark:text-indigo-300" />
            },
            ...remote
        ];
    }, [nodes]);

  // Get resources from Twin
  const resources = twin?.nodes?.[selectedNode]?.resources;
  
  if (!resources || !resources.os) {
      return (
        <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <SectionLoading
                message="Waiting for agent report..."
                subMessage={selectedNode !== 'Local' ? `Waiting for data from ${selectedNode}` : undefined}
            />
        </div>
      );
  }

  const { cpuUsage, memoryUsage, totalMemory, os, disks, network, dnsResolvers, cpu, gpus } = resources;

  // The box's own non-internal IPs — a resolver matching one of these is the
  // box pointing at its own AdGuard.
  const boxAddresses = network
    ? Object.values(network).flat().filter(a => !a.internal).map(a => a.address)
    : [];
  const dnsSummary = summarizeDnsResolvers(dnsResolvers, boxAddresses);

  return (
      <div className="p-4 md:p-6 space-y-6">
        {/* Node Selector */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Node</h3>
          <Select
            options={nodeOptions}
            value={selectedNode}
            onChange={handleSelectNode}
            placeholder="Select node"
            compact
          />
        </div>
        {/* OS Overview */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-2 text-gray-500">
                    <Server size={18} />
                    <span className="text-sm font-medium">Hostname</span>
                </div>
                <div className="text-lg font-semibold truncate" title={twin?.serverName || os.hostname}>{twin?.serverName || os.hostname}</div>
                <div className="text-xs text-gray-400">{twin?.serverName ? os.hostname + ' · ' : ''}Node ID: {selectedNode}</div>
            </div>
            
            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-2 text-gray-500">
                    <Info size={18} />
                    <span className="text-sm font-medium">OS / Kernel</span>
                </div>
                <div className="text-lg font-semibold truncate" title={os.platform}>{os.platform}</div>
                <div className="text-xs text-gray-400">Arch: {os.arch}</div>
            </div>

            <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <div className="flex items-center gap-2 mb-2 text-gray-500">
                    <RefreshCw size={18} />
                    <span className="text-sm font-medium">Uptime</span>
                </div>
                <div className="text-lg font-semibold">{(os.uptime / 3600).toFixed(1)} hrs</div>
                <div className="text-xs text-gray-400">Total running time</div>
            </div>

             <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700 flex flex-col justify-between h-full">
                <div>
                    <div className="flex items-center gap-2 mb-2 text-gray-500">
                        <Package size={18} />
                        <span className="text-sm font-medium">Pending Updates</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <div>
                            {checkingUpdates ? (
                                <div className="text-sm animate-pulse">Checking...</div>
                            ) : (
                                <div className={`text-lg font-semibold ${updates && updates.count > 0 ? 'text-yellow-600 dark:text-yellow-500' : 'text-green-600 dark:text-green-500'}`}>
                                    {updates ? updates.count : 0}
                                </div>
                            )}
                            <div className="text-xs text-gray-400">System packages</div>
                        </div>
                         {updates && updates.count > 0 && (
                            <button 
                                onClick={handleCopyCommand}
                                className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition text-gray-500 hover:text-gray-800 dark:hover:text-gray-200"
                                title="Copy update command"
                            >
                                {copied ? <Check size={16} className="text-green-500"/> : <Copy size={16}/>}
                            </button>
                        )}
                    </div>
                </div>
                <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700 flex justify-end">
                    <Link
                        href={`/settings/system?node=${selectedNode}`}
                        className="inline-flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 font-medium transition-colors"
                        title="Configure update windows and automatic updates"
                    >
                        <Settings size={12} />
                        Configure Updates
                    </Link>
                </div>
            </div>
        </div>

        {/* Resources */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* CPU & Memory */}
            <div className="bg-white dark:bg-gray-800 p-5 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
                    <Cpu size={20} /> Compute Resources
                </h3>
                
                <div className="space-y-6">
                    {cpu && (
                        <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded text-sm space-y-2 border border-gray-200 dark:border-gray-700">
                            <div className="flex justify-between items-start gap-2">
                                <span className="text-gray-500 whitespace-nowrap">Model</span>
                                <span className="font-medium text-right break-words" title={cpu.model}>{cpu.model}</span>
                            </div>
                             <div className="flex justify-between">
                                <span className="text-gray-500">Cores</span>
                                <span className="font-medium">{cpu.cores}</span>
                            </div>
                        </div>
                    )}
                    <div>
                        <div className="flex justify-between mb-1 text-sm">
                            <span>CPU Usage</span>
                            <span className={`font-medium ${cpuUsage > 90 ? 'text-red-600 dark:text-red-400' : cpuUsage > 80 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{cpuUsage}%</span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                            <div className={`h-2.5 rounded-full transition-all duration-500 ${cpuUsage > 90 ? 'bg-red-500' : cpuUsage > 80 ? 'bg-amber-500' : 'bg-blue-600'}`} style={{ width: `${Math.min(cpuUsage, 100)}%` }}></div>
                        </div>
                    </div>

                    <div>
                        <div className="flex justify-between mb-1 text-sm">
                            <span>Memory Usage</span>
                            <span className="font-medium">{formatBytes(memoryUsage)} / {formatBytes(totalMemory)}</span>
                        </div>
                        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5">
                            {(() => { const memPercent = totalMemory > 0 ? (memoryUsage / totalMemory) * 100 : 0; return (
                                <div className={`h-2.5 rounded-full transition-all duration-500 ${memPercent > 90 ? 'bg-red-500' : memPercent > 80 ? 'bg-amber-500' : 'bg-purple-600'}`} style={{ width: `${Math.min(memPercent, 100)}%` }} />
                            ); })()}
                        </div>
                    </div>
                </div>
            </div>

            {/* Disk Usage */}
            <div className="bg-white dark:bg-gray-800 p-5 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
                    <HardDrive size={20} /> Storage ({disks?.length || 0} mounts)
                </h3>
                
                <div className="space-y-4 max-h-72 overflow-y-auto pr-2">
                    {disks && disks.map((disk: DiskInfo, i: number) => {
                        const percent = disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : 0;
                        const role = describeMountRole(disk.mountpoint);
                        return (
                        <div key={i} className="text-sm">
                            <div className="flex justify-between items-baseline mb-0.5">
                                <span className="font-medium truncate" title={disk.mountpoint}>{disk.mountpoint}</span>
                                {role && (
                                    <span className="text-xs text-gray-500 dark:text-gray-400 ml-2 shrink-0">{role}</span>
                                )}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1 truncate" title={disk.device}>
                                {disk.type}
                                {disk.device && (
                                    <>
                                        <span className="mx-1">·</span>
                                        <span className="font-mono">{disk.device}</span>
                                    </>
                                )}
                            </div>
                            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 relative">
                                <div
                                    className={`absolute left-0 h-2 rounded-full transition-all duration-500 ${percent > 90 ? 'bg-red-500' : percent > 80 ? 'bg-amber-500' : 'bg-green-600'}`}
                                    style={{ width: `${Math.min(percent, 100)}%` }}
                                ></div>
                            </div>
                            <div className="flex justify-between mt-1 text-xs text-gray-400">
                                <span>{formatBytes(disk.used)} used</span>
                                <span>{percent}% of {formatBytes(disk.total)}</span>
                            </div>
                        </div>
                    )})}
                    {(!disks || disks.length === 0) && (
                        <div className="text-center text-gray-400 py-4">No disk information available</div>
                    )}
                </div>
            </div>

            {/* GPUs — only shown when the agent reports at least one. CPU-only
                hosts get nothing here so the grid stays compact. */}
            {gpus && gpus.length > 0 && (
                <div className="bg-white dark:bg-gray-800 p-5 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                    <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
                        <Cpu size={20} /> Graphics ({gpus.length})
                    </h3>
                    <div className="grid grid-cols-1 gap-4">
                        {gpus.map((gpu, i) => {
                            const memUsedFrac = (gpu.memoryUsed != null && gpu.memoryTotal && gpu.memoryTotal > 0)
                                ? Math.round((gpu.memoryUsed / gpu.memoryTotal) * 100) : null;
                            return (
                                <div key={gpu.uuid ?? i} className="text-sm">
                                    <div className="font-medium truncate" title={gpu.name}>{gpu.name}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-2 flex flex-wrap gap-x-3">
                                        <span className="uppercase">{gpu.vendor}</span>
                                        {gpu.driver && <span>driver {gpu.driver}</span>}
                                        {gpu.uuid && <span className="font-mono truncate" title={gpu.uuid}>{gpu.uuid.slice(0, 18)}…</span>}
                                    </div>
                                    {/* Memory bar */}
                                    {gpu.memoryTotal && gpu.memoryTotal > 0 && (
                                        <div className="mb-2">
                                            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-0.5">
                                                <span>VRAM</span>
                                                <span>{formatBytes(gpu.memoryUsed ?? 0)} / {formatBytes(gpu.memoryTotal)}{memUsedFrac != null && ` (${memUsedFrac}%)`}</span>
                                            </div>
                                            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 relative">
                                                <div
                                                    className={`absolute left-0 h-2 rounded-full transition-all duration-500 ${(memUsedFrac ?? 0) > 90 ? 'bg-red-500' : (memUsedFrac ?? 0) > 80 ? 'bg-amber-500' : 'bg-green-600'}`}
                                                    style={{ width: `${Math.min(memUsedFrac ?? 0, 100)}%` }}
                                                ></div>
                                            </div>
                                        </div>
                                    )}
                                    {/* Compute bar */}
                                    {gpu.utilizationGpu != null && (
                                        <div className="mb-2">
                                            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-0.5">
                                                <span>Compute</span>
                                                <span>{gpu.utilizationGpu}%</span>
                                            </div>
                                            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 relative">
                                                <div
                                                    className="absolute left-0 h-2 rounded-full transition-all duration-500 bg-blue-500"
                                                    style={{ width: `${Math.min(gpu.utilizationGpu, 100)}%` }}
                                                ></div>
                                            </div>
                                        </div>
                                    )}
                                    {/* Compact metadata row */}
                                    <div className="text-xs text-gray-500 dark:text-gray-400 flex flex-wrap gap-x-3 mt-1">
                                        {gpu.temperatureC != null && <span>{gpu.temperatureC}°C</span>}
                                        {gpu.powerDraw != null && gpu.powerLimit != null && (
                                            <span>{gpu.powerDraw.toFixed(0)} / {gpu.powerLimit.toFixed(0)} W</span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Network Interfaces (+ DNS resolvers sub-section, folded in per #1706) */}
            <div className="bg-white dark:bg-gray-800 p-5 rounded-lg shadow-sm border border-gray-100 dark:border-gray-700">
                <h3 className="text-lg font-medium mb-4 flex items-center gap-2">
                    <Network size={20} /> Network Interfaces
                </h3>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {network && Object.entries(network).map(([ifaceName, addrs]) => (
                        <div key={ifaceName} className="border border-gray-200 dark:border-gray-700 rounded p-3">
                            <div className="font-medium text-sm mb-2 pb-1 border-b border-gray-100 dark:border-gray-800 flex justify-between items-center">
                                <span>{ifaceName}</span>
                                {(addrs as NetworkAddr[]).some(a => !a.internal) ?
                                    <span className="text-[10px] bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-100 px-1.5 py-0.5 rounded">Public</span> :
                                    <span className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded">Local</span>
                                }
                            </div>
                            <div className="space-y-1">
                                {(addrs as NetworkAddr[]).map((addr, idx) => (
                                    <div key={idx} className="text-xs font-mono break-all flex justify-between gap-2">
                                        <span className={addr.family === 'IPv6' ? 'text-purple-600 dark:text-purple-400' : 'text-emerald-600 dark:text-emerald-400'}>
                                            {addr.address}
                                        </span>
                                        <span className="text-gray-400 shrink-0">{addr.family}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                    {(!network || Object.keys(network).length === 0) && (
                        <div className="col-span-full text-center text-gray-400 py-4">No network information available</div>
                    )}
                </div>

                {/* DNS resolvers — the box's effective resolver list, labelled.
                    Folded in here (#1706) rather than its own card. A public
                    resolver is the #1559 split-horizon trap (breaks *.<domain>
                    SSO resolution after reinstall), so it stays prominent. */}
                <div className="mt-6 pt-4 border-t border-gray-100 dark:border-gray-700">
                    <h4 className="text-sm font-medium mb-3 flex items-center gap-2 text-gray-600 dark:text-gray-300">
                        <Network size={16} /> DNS resolvers ({dnsSummary.resolvers.length})
                    </h4>

                    {dnsSummary.hasPublicResolver && (
                        <div className="mb-3 flex items-start gap-2 p-3 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-sm">
                            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                            <div>
                                <div className="font-medium">A public DNS resolver is configured</div>
                                <div className="text-xs mt-0.5 opacity-90">
                                    Public resolvers don&apos;t know your LAN addresses, so they can silently break
                                    split-horizon resolution of <span className="font-mono">*.&lt;domain&gt;</span> after a
                                    reinstall (SSO logins fail). Point the box at AdGuard / the router instead.
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="space-y-2">
                        {dnsSummary.resolvers.map((r, i) => {
                            const labelStyles: Record<DnsResolverLabel, string> = {
                                AdGuard: 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-100',
                                router: 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-100',
                                public: 'bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-100',
                                other: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300',
                            };
                            return (
                                <div key={i} className="flex items-center justify-between gap-2 text-sm border border-gray-100 dark:border-gray-800 rounded px-3 py-2">
                                    <span className="font-mono break-all">{r.address}</span>
                                    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${labelStyles[r.label]}`}>
                                        {r.label}
                                    </span>
                                </div>
                            );
                        })}
                        {dnsSummary.resolvers.length === 0 && (
                            <div className="text-center text-gray-400 py-4">No DNS resolver information available</div>
                        )}
                    </div>

                    {dnsSummary.resolvers.length > 0 && !dnsSummary.hasPublicResolver && (
                        <div className="mt-3 flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                            <ShieldCheck size={14} />
                            <span>All resolvers are local (AdGuard / router) — split-horizon resolution is safe.</span>
                        </div>
                    )}

                    {dnsResolvers?.source && dnsResolvers.source !== 'unknown' && (
                        <div className="mt-2 text-[10px] text-gray-400">source: {dnsResolvers.source}</div>
                    )}
                </div>
            </div>
        </div>
      </div>
  );
}
