import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Box, Terminal as TerminalIcon, MoreVertical, X, Power, RotateCw, Trash2, AlertTriangle, Activity, ArrowLeft, Search } from 'lucide-react';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';

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
  Mounts?: (string | { Source: string; Destination: string; Type: string })[];
  Labels?: { [key: string]: string };
}

export default function ContainersPlugin() {
  const router = useRouter();
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedContainer, setSelectedContainer] = useState<Container | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { addToast, updateToast } = useToast();

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/containers');
      if (res.ok) setContainers(await res.json());
    } catch (error) {
      console.error('Failed to fetch containers', error);
      addToast('error', 'Failed to fetch containers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();

    // Setup SSE for real-time updates
    const eventSource = new EventSource('/api/stream');
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'container') {
           // Refresh data on container change
           setTimeout(() => {
               fetchData();
           }, 500);
        }
      } catch (e) {
        console.error('Error parsing SSE message', e);
      }
    };

    return () => {
      eventSource.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openLogs = (container: Container) => {
    router.push(`/containers/${container.Id}/logs`);
  };

  const openTerminal = (container: Container) => {
    router.push(`/containers/${container.Id}/terminal`);
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
        const res = await fetch(`/api/containers/${selectedContainer.Id}/action`, {
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
            setTimeout(fetchData, 1000);
        }
    } catch (e) {
        console.error('Action failed', e);
        updateToast(toastId, 'error', 'Action failed', 'An unexpected error occurred.');
    } finally {
        setActionLoading(false);
    }
  };

  const filteredContainers = containers.filter(c => {
    const query = searchQuery.toLowerCase();
    return (
        c.Names[0].toLowerCase().includes(query) ||
        c.Image.toLowerCase().includes(query) ||
        c.Id.toLowerCase().includes(query)
    );
  });

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
      <div className="flex flex-col gap-4 mb-6 p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <div className="flex justify-between items-center">
            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Running Containers</h2>
            <button onClick={fetchData} className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" title="Refresh">
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
        </div>
        <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input 
                type="text" 
                placeholder="Search containers by name, image or ID..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
            <div className="text-center text-gray-500 mt-10">Loading containers...</div>
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
                                            <h3 className="font-bold text-lg text-gray-900 dark:text-gray-100">{c.Names[0].replace(/^\//, '')}</h3>
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
                                    {c.Ports && c.Ports.length > 0 && (
                                        <div className="md:col-span-2">
                                            <span className="font-semibold block mb-1 text-xs uppercase text-gray-500">Ports</span>
                                            <div className="flex flex-wrap gap-1">
                                                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                                                {c.Ports.map((p: any, i) => {
                                                    const hostPort = p.PublicPort || p.host_port;
                                                    const containerPort = p.PrivatePort || p.container_port;
                                                    const protocol = p.Type || p.protocol;
                                                    return (
                                                        <span key={i} className="bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded text-xs font-mono">
                                                            {hostPort ? `${hostPort}:` : ''}{containerPort}/{protocol}
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
