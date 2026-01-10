import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import { logger } from '@/lib/logger';
import PluginLoading from '@/components/PluginLoading';
import { RefreshCw, Box, Terminal as TerminalIcon, MoreVertical, X, Power, RotateCw, Trash2, AlertTriangle, Activity, ArrowLeft, Search } from 'lucide-react';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import PageHeader from '@/components/PageHeader';
// import { getNodes } from '@/app/actions/nodes'; // Not needed
// import { PodmanConnection } from '@/lib/nodes'; // Not needed

interface Container {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Created: number;
  Pod?: string;
  PodName?: string;
  // Support both formats (standard Podman JSON vs Docker-like)
  Ports?: ({ IP?: string; PrivatePort: number; PublicPort?: number; Type: string } | { host_ip?: string; container_port: number; host_port?: number; protocol: string })[];
  // Mounts?: (string | { Source: string; Destination: string; Type: string })[]; // Not strict check
  Mounts?: any[];
  Labels?: { [key: string]: string };
  NetworkMode?: string;
  IsHostNetwork?: boolean;
  nodeName?: string;
}

export default function ContainersPlugin() {
  const router = useRouter();
  const { data: twin, isConnected, isNodeSynced } = useDigitalTwin();

  const [filteredContainers, setFilteredContainers] = useState<Container[]>([]);
  const [selectedContainer, setSelectedContainer] = useState<Container | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { addToast, updateToast } = useToast();

  const containers = useMemo(() => {
    if (!twin || !twin.nodes) return [];
    
    const list: Container[] = [];
    Object.entries(twin.nodes).forEach(([nodeName, nodeState]) => {
        nodeState.containers.forEach(ec => {
            // Map enriched container to UI interface
            list.push({
                Id: ec.id,
                Names: ec.names,
                Image: ec.image,
                State: ec.state,
                Status: ec.status,
                Created: ec.created,
                nodeName: nodeName,
                // Ports need mapping from {hostPort, containerPort, protocol} to UI format
                Ports: (ec.ports || []).map(p => ({
                    host_ip: '0.0.0.0', // Default
                    host_port: p.host_port || p.hostPort,
                    container_port: p.container_port || p.containerPort || 0,
                    protocol: p.protocol
                })),
                Mounts: ec.mounts || [],
                Labels: ec.labels || {},
                // NetworkMode? Not directly available on EnrichedContainer yet, maybe in misc
                NetworkMode: (ec.networks && ec.networks.length > 0) ? ec.networks[0] : 'default',
                Pod: ec.podId,
                PodName: ec.podName
            });
        });
    });
    return list;
  }, [twin]);

  const loading = !isConnected && containers.length === 0;
  // If we are connected but no data yet, check sync status
  const waitingForSync = isConnected && !isNodeSynced() && containers.length === 0;
  
  const validating = false;
  const refreshing = false;
  const refresh = () => {}; // No-op as twin updates auto

  // Legacy SSE Removed
  /*
  useEffect(() => {
    // ...
  }, []);
  */

  useEffect(() => {
      let filtered = containers;
      
      // Filter by Search
      if (searchQuery) {
          const q = searchQuery.toLowerCase();
          filtered = filtered.filter(c => 
              c.Names.some(n => n.toLowerCase().includes(q)) ||
              c.Id.toLowerCase().includes(q) ||
              c.Image.toLowerCase().includes(q) ||
              (c.nodeName && c.nodeName.toLowerCase().includes(q))
          );
      }
      
      setFilteredContainers(filtered);
  }, [containers, searchQuery]);

  const openLogs = (container: Container) => {
    router.push(`/containers/${container.Id}/logs?node=${container.nodeName === 'Local' ? '' : container.nodeName}`);
  };

  const openTerminal = (container: Container) => {
    router.push(`/containers/${container.Id}/terminal?node=${container.nodeName === 'Local' ? '' : container.nodeName}`);
  };

  const openActions = (container: Container) => {
    setSelectedContainer(container);
    setShowActions(true);
  };

  const handleAction = async (action: string) => {
    if (!selectedContainer) return;
    
    if (action === 'delete' && !deleteModalOpen) {
        setDeleteModalOpen(true);
        return;
    }

    if (action === 'delete') {
        setDeleteModalOpen(false);
    }

    setActionLoading(true);
    const toastId = addToast('loading', 'Action in progress', `Executing ${action} on container...`, 0);

    try {
        const nodeParam = selectedContainer.nodeName === 'Local' ? '' : selectedContainer.nodeName;
        const query = nodeParam ? `?node=${nodeParam}` : '';
        const res = await fetch(`/api/containers/${selectedContainer.Id}/action${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        
        if (!res.ok) {
            const data = await res.json();
            updateToast(toastId, 'error', 'Action failed', data.error);
        } else {
            setShowActions(false);
            updateToast(toastId, 'success', 'Action initiated', `${action} command sent to container`);
            // Wait a bit for the action to take effect
            setTimeout(() => refresh(), 1000);
        }
    } catch (e) {
        logger.error('ContainersPlugin', 'Action failed', e);
        updateToast(toastId, 'error', 'Action failed', 'An unexpected error occurred.');
    } finally {
        setActionLoading(false);
    }
  };



  const getGroupName = (c: Container) => {
    if (c.PodName) return `Pod: ${c.PodName}`;
    if (c.Labels) {
        if (c.Labels['io.kubernetes.pod.name']) return `Pod: ${c.Labels['io.kubernetes.pod.name']}`;
        if (c.Labels['io.podman.pod.name']) return `Pod: ${c.Labels['io.podman.pod.name']}`;
        if (c.Labels['com.docker.compose.project']) return `Compose: ${c.Labels['com.docker.compose.project']}`;
    }
    return 'Standalone Containers';
  };

  const groupedContainers = filteredContainers.reduce((acc, c) => {
    const group = getGroupName(c);
    if (!acc[group]) acc[group] = [];
    acc[group].push(c);
    return acc;
  }, {} as Record<string, Container[]>);

  const sortedGroups = Object.keys(groupedContainers).sort((a, b) => {
    if (a === 'Standalone Containers') return 1;
    if (b === 'Standalone Containers') return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="h-full flex flex-col relative">
      <ConfirmModal 
        isOpen={deleteModalOpen}
        title="Delete Container"
        message={`Are you sure you want to delete container "${selectedContainer?.Names[0].replace(/^\//, '')}"? This action cannot be undone.`}
        confirmText="Delete"
        isDestructive
        onConfirm={() => handleAction('delete')}
        onCancel={() => setDeleteModalOpen(false)}
      />
      <PageHeader 
        title="Containers" 
        showBack={false} 
        helpId="containers"
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

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
            <PluginLoading message="Connecting to Agent..." />
        ) : waitingForSync ? (
            <PluginLoading message="Synchronizing state..." />
        ) : filteredContainers.length === 0 ? (
            <div className="text-center text-gray-500 mt-10">
                {containers.length > 0 ? 'No containers match your search.' : 'No active containers found.'}
            </div>
        ) : (
            <div className="space-y-8">
                {sortedGroups.map(group => (
                    <div key={group} className="bg-gray-50/50 dark:bg-gray-900/30 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-4 pb-2 border-b border-gray-200 dark:border-gray-700">
                            <Box className="text-indigo-500" size={20} />
                            <h3 className="text-sm font-bold text-gray-700 dark:text-gray-200 uppercase tracking-wider">
                                {group}
                            </h3>
                            <span className="ml-auto text-xs font-mono bg-gray-200 dark:bg-gray-800 px-2 py-1 rounded-full text-gray-600 dark:text-gray-400">
                                {groupedContainers[group].length} containers
                            </span>
                        </div>
                        <div className="grid gap-4">
                            {groupedContainers[group].map((c) => (
                            <div key={c.Id} className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 hover:shadow-md transition-all duration-200">
                                <div className="flex flex-col md:flex-row md:items-center gap-4 justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className={`w-3 h-3 rounded-full ${c.State === 'running' ? 'bg-green-500' : 'bg-gray-500'}`} />
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <h3 className="font-bold text-lg text-gray-900 dark:text-gray-100">{c.Names[0].replace(/^\//, '')}</h3>
                                                {c.nodeName && (
                                                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200 dark:border-blue-800">
                                                        {c.nodeName}
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{c.Id.substring(0, 12)}</div>
                                        </div>
                                    </div>
                                    
                                    <div className="flex items-center gap-2">
                                        <button 
                                            onClick={() => openLogs(c)}
                                            className="p-2 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                                            title="Logs & Info"
                                        >
                                            <Activity size={18} />
                                        </button>
                                        <button 
                                            onClick={() => openTerminal(c)}
                                            className="p-2 text-gray-500 dark:text-gray-400 hover:text-green-600 dark:hover:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 rounded transition-colors"
                                            title="Terminal"
                                        >
                                            <TerminalIcon size={18} />
                                        </button>
                                        <button 
                                            onClick={() => openActions(c)}
                                            className="p-2 text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded transition-colors"
                                            title="Actions"
                                        >
                                            <MoreVertical size={18} />
                                        </button>
                                    </div>
                                </div>
                                
                                {/* Details */}
                                <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-600 dark:text-gray-400">
                                    <div>
                                        <span className="font-semibold block mb-1 text-xs uppercase text-gray-500">Image</span>
                                        <span className="break-all">{c.Image}</span>
                                    </div>
                                    <div>
                                        <span className="font-semibold block mb-1 text-xs uppercase text-gray-500">Status</span>
                                        <span>{c.Status}</span>
                                    </div>
                                    {c.IsHostNetwork && (
                                        <div className="md:col-span-2">
                                            <span className="font-semibold block mb-1 text-xs uppercase text-gray-500">Network</span>
                                            <span className="bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300 px-2 py-1 rounded text-xs font-medium">
                                                Host Network
                                            </span>
                                        </div>
                                    )}
                                    {c.Ports && c.Ports.length > 0 && (
                                        <div className="md:col-span-2">
                                            <span className="font-semibold block mb-1 text-xs uppercase text-gray-500">Ports</span>
                                            <div className="flex flex-wrap gap-1">
                                                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                                                {c.Ports.map((p: any, i) => {
                                                    const hostPort = p.PublicPort || p.host_port;
                                                    const containerPort = p.PrivatePort || p.container_port;
                                                    const protocol = (p.Type || p.protocol || 'tcp').toLowerCase();
                                                    
                                                    // Display format: 
                                                    // With Host Map: 8080:80/tcp
                                                    // Without Host Map: 80/tcp
                                                    
                                                    const display = hostPort && hostPort !== containerPort 
                                                        ? `${hostPort}:${containerPort}/${protocol}`
                                                        : hostPort // If same, usually host net
                                                            ? `${hostPort}/${protocol}`
                                                            : `${containerPort}/${protocol}`;

                                                    return (
                                                        <span key={i} className="bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded text-xs font-mono border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300">
                                                            {display}
                                                        </span>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        )}
      </div>

      {/* Actions Overlay */}
      {showActions && selectedContainer && (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-md border border-gray-200 dark:border-gray-800 p-6">
                <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center gap-4">
                        <button onClick={() => setShowActions(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1 text-sm font-medium">
                            <ArrowLeft size={18} />
                            Back
                        </button>
                        <h3 className="text-lg font-bold">Container Actions</h3>
                    </div>
                    <button onClick={() => setShowActions(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="mb-6">
                    <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg mb-4">
                        <Box className="text-blue-500" />
                        <div>
                            <div className="font-medium">{selectedContainer.Names[0].replace(/^\//, '')}</div>
                            <div className="text-xs text-gray-500 font-mono">{selectedContainer.Id.substring(0, 12)}</div>
                        </div>
                    </div>
                </div>

                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <button 
                            onClick={() => handleAction('stop')}
                            disabled={actionLoading}
                            className="flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                            <Power size={18} className="text-orange-500" />
                            <span>Stop</span>
                        </button>
                        <button 
                            onClick={() => handleAction('restart')}
                            disabled={actionLoading}
                            className="flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                            <RotateCw size={18} className="text-blue-500" />
                            <span>Restart</span>
                        </button>
                    </div>
                    
                    <div className="border-t border-gray-200 dark:border-gray-800 my-4 pt-4">
                        <h4 className="text-xs font-semibold text-gray-500 uppercase mb-3 flex items-center gap-2">
                            <AlertTriangle size={12} />
                            Destructive Actions
                        </h4>
                        <div className="grid grid-cols-2 gap-3">
                            <button 
                                onClick={() => handleAction('force-stop')}
                                disabled={actionLoading}
                                className="flex items-center justify-center gap-2 p-3 rounded-lg border border-red-200 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20 text-red-700 dark:text-red-400 transition-colors"
                            >
                                <Power size={18} />
                                <span>Force Stop</span>
                            </button>
                            <button 
                                onClick={() => handleAction('force-restart')}
                                disabled={actionLoading}
                                className="flex items-center justify-center gap-2 p-3 rounded-lg border border-red-200 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20 text-red-700 dark:text-red-400 transition-colors"
                            >
                                <RotateCw size={18} />
                                <span>Force Restart</span>
                            </button>
                        </div>
                        <button 
                            onClick={() => handleAction('delete')}
                            disabled={actionLoading}
                            className="w-full mt-3 flex items-center justify-center gap-2 p-3 rounded-lg border border-red-200 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/20 text-red-700 dark:text-red-400 transition-colors"
                        >
                            <Trash2 size={18} />
                            <span>Delete Container</span>
                        </button>
                    </div>
                </div>
                
                {actionLoading && (
                    <div className="absolute inset-0 bg-white/50 dark:bg-gray-900/50 flex items-center justify-center rounded-lg">
                        <RefreshCw className="animate-spin text-blue-500" size={32} />
                    </div>
                )}
            </div>
        </div>
      )}
    </div>
  );
}
