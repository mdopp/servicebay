import { useState, useEffect, useMemo, useCallback, FormEvent, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';
import PluginLoading from '@/components/PluginLoading';
import { Box, Terminal as TerminalIcon, MoreVertical, X, Trash2, Activity, Search, HardDrive, Plus, RefreshCw, Eraser } from 'lucide-react';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import PageHeader from '@/components/PageHeader';
import { Volume } from '@/lib/agent/types';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { useContainerActions } from '@/hooks/useContainerActions';
import ContainerLogsPanel, { ContainerLogsPanelData } from '@/components/ContainerLogsPanel';
import type { TerminalRef } from '@/components/Terminal';
import type { ServiceBundle } from '@/lib/unmanaged/bundleShared';

const DynamicTerminal = dynamic(() => import('@/components/Terminal'), {
    ssr: false,
});
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
    isInfra?: boolean;
  // Support both formats (standard Podman JSON vs Docker-like)
  Ports?: { hostIp?: string; containerPort: number; hostPort?: number; protocol: string }[];
  // Mounts?: (string | { Source: string; Destination: string; Type: string })[]; // Not strict check
  Mounts?: unknown[];
  Labels?: { [key: string]: string };
  NetworkMode?: string;
  IsHostNetwork?: boolean;
  nodeName?: string;
    parent?: {
        type: 'service' | 'bundle';
        name: string;
    };
}

type ContainerEngineTab = 'containers' | 'volumes';

interface ContainersPluginProps {
    defaultTab?: ContainerEngineTab;
}

export default function ContainersPlugin({ defaultTab = 'containers' }: ContainersPluginProps) {
    const router = useRouter();
    const pathname = usePathname() || '';
    const searchParams = useSearchParams();
  const { data: twin, isConnected, isNodeSynced } = useDigitalTwin();

    const [filteredContainers, setFilteredContainers] = useState<Container[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
    const [showInfra, setShowInfra] = useState(false);
    const [activeTab, setActiveTab] = useState<ContainerEngineTab>(defaultTab);
    const [showSystemVolumes, setShowSystemVolumes] = useState(false);
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [newVolName, setNewVolName] = useState('');
    const [newVolPath, setNewVolPath] = useState('');
    const [creatingVolume, setCreatingVolume] = useState(false);
    const [volumeToDelete, setVolumeToDelete] = useState<Volume | null>(null);
    const [drawerMode, setDrawerMode] = useState<'logs' | 'terminal' | null>(null);
    const [drawerContainer, setDrawerContainer] = useState<Container | null>(null);
  const { addToast, updateToast } = useToast();
        const terminalRef = useRef<TerminalRef>(null);
    const searchString = searchParams?.toString() ?? '';
    const tabParam = searchParams?.get('tab');
    const normalizedTab: ContainerEngineTab | null =
        tabParam === 'volumes' || tabParam === 'containers'
            ? (tabParam as ContainerEngineTab)
            : null;

    const closeCreateModal = useCallback(() => {
        setIsCreateOpen(false);
    }, []);

    const closeDrawer = useCallback(() => {
        setDrawerMode(null);
        setDrawerContainer(null);
    }, []);

    const {
        openActions: openContainerActions,
        closeActions: closeContainerActions,
        overlay: containerActionsOverlay,
        isOpen: containerActionsOpen,
    } = useContainerActions();

    useEscapeKey(closeContainerActions, containerActionsOpen, true);
    useEscapeKey(closeCreateModal, isCreateOpen, true);
    const shouldCloseDrawerOnEscape = Boolean(drawerMode) && drawerMode !== 'terminal' && drawerMode !== 'logs';
    useEscapeKey(closeDrawer, shouldCloseDrawerOnEscape, true);

    useEffect(() => {
        if (!normalizedTab) return;
        setActiveTab((current) => (current === normalizedTab ? current : normalizedTab));
    }, [normalizedTab]);

    useEffect(() => {
        if (!tabParam && defaultTab === 'volumes') {
            setActiveTab('volumes');
            const params = new URLSearchParams(searchString);
            params.set('tab', 'volumes');
            const nextQuery = params.toString();
            router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
        }
    }, [defaultTab, tabParam, pathname, router, searchString]);

    const handleTabChange = useCallback((nextTab: ContainerEngineTab) => {
        if (nextTab === activeTab) return;
        setActiveTab(nextTab);
        const params = new URLSearchParams(searchString);
        if (nextTab === 'containers') {
            params.delete('tab');
        } else {
            params.set('tab', nextTab);
        }
        const nextQuery = params.toString();
        router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, { scroll: false });
    }, [activeTab, pathname, router, searchString]);

  const containerParentMap = useMemo(() => {
    const map = new Map<string, { type: 'service' | 'bundle'; name: string }>();
    if (!twin || !twin.nodes) return map;

    Object.values(twin.nodes).forEach(nodeState => {
        (nodeState.services || []).forEach(service => {
            (service.associatedContainerIds || []).forEach(containerId => {
                if (!containerId) return;
                const displayName = service.name.replace(/\.service$/, '');
                map.set(containerId, { type: 'service', name: displayName });
            });
        });

        const unmanagedBundles = Array.isArray((nodeState as { unmanagedBundles?: ServiceBundle[] }).unmanagedBundles)
            ? (nodeState as { unmanagedBundles?: ServiceBundle[] }).unmanagedBundles!
            : [];
        unmanagedBundles.forEach(bundle => {
            (bundle.containers || []).forEach(containerSummary => {
                if (!containerSummary.id) return;
                map.set(containerSummary.id, { type: 'bundle', name: bundle.displayName });
            });
        });
    });

    return map;
  }, [twin]);

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
                isInfra: ec.isInfra,
                // Ports need mapping from {hostPort, containerPort, protocol} to UI format
                Ports: (ec.ports || []).map(p => ({
                    hostIp: p.hostIp || '0.0.0.0',
                    hostPort: p.hostPort,
                    containerPort: p.containerPort || 0,
                    protocol: p.protocol
                })),
                Mounts: ec.mounts || [],
                Labels: ec.labels || {},
                // NetworkMode? Not directly available on EnrichedContainer yet, maybe in misc
                NetworkMode: (ec.networks && ec.networks.length > 0) ? ec.networks[0] : 'default',
                IsHostNetwork: ec.isHostNetwork,
                Pod: ec.podId,
                PodName: ec.podName,
                parent: containerParentMap.get(ec.id)
            });
        });
    });
    return list;
  }, [containerParentMap, twin]);

    const volumes = useMemo(() => {
        if (!twin || !twin.nodes) return [];

        const list: Volume[] = [];
        Object.entries(twin.nodes).forEach(([nodeName, nodeState]) => {
            (nodeState.volumes || []).forEach(volume => {
                list.push({
                    ...volume,
                    Node: volume.Node || nodeName
                });
            });
        });
        return list;
    }, [twin]);

    const visibleVolumes = useMemo(() => {
        const scoped = showSystemVolumes ? volumes : volumes.filter(vol => !vol.Anonymous);
        if (!searchQuery) return scoped;
        const q = searchQuery.toLowerCase();
        return scoped.filter(vol => {
            const usedByNames = (vol.UsedBy || []).map(consumer => consumer.name.toLowerCase());
            return (
                vol.Name.toLowerCase().includes(q) ||
                (!!vol.Node && vol.Node.toLowerCase().includes(q)) ||
                (!!vol.Driver && vol.Driver.toLowerCase().includes(q)) ||
                (!!vol.Mountpoint && vol.Mountpoint.toLowerCase().includes(q)) ||
                usedByNames.some(name => name.includes(q))
            );
        });
    }, [volumes, showSystemVolumes, searchQuery]);

  const loading = !isConnected && containers.length === 0;
  // If we are connected but no data yet, check sync status
  const waitingForSync = isConnected && !isNodeSynced() && containers.length === 0;
    const volumesLoading = !twin || !twin.nodes;
  
  // const validating = false;
  // const refreshing = false;
  // const refresh = () => {}; // No-op as twin updates auto

  // Legacy SSE Removed
  /*
  useEffect(() => {
    // ...
  }, []);
  */

  useEffect(() => {
      let filtered = containers;

      if (!showInfra) {
          filtered = filtered.filter(c => !c.isInfra);
      }
      
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
  }, [containers, searchQuery, showInfra]);

    const openLogs = (container: Container) => {
        setDrawerContainer(container);
        setDrawerMode('logs');
    };

    const openTerminal = (container: Container) => {
        setDrawerContainer(container);
        setDrawerMode('terminal');
    };

  const openActions = useCallback((container: Container) => {
        openContainerActions({
            id: container.Id,
            name: container.Names[0]?.replace(/^\//, '') || container.Id,
            nodeName: container.nodeName,
        });
    }, [openContainerActions]);

  const handleDeleteVolume = async () => {
    if (!volumeToDelete) return;

    const toastId = addToast('loading', 'Deleting volume', volumeToDelete.Name, 0);
    try {
        const query = volumeToDelete.Node ? `?node=${volumeToDelete.Node}` : '';
        const res = await fetch(`/api/volumes/${volumeToDelete.Name}${query}`, { method: 'DELETE' });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to delete volume');
        }

        updateToast(toastId, 'success', 'Volume deleted', volumeToDelete.Name);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete volume';
        updateToast(toastId, 'error', 'Delete failed', message);
    } finally {
        setVolumeToDelete(null);
    }
  };

  const handleCreateVolume = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newVolName.trim()) return;

    setCreatingVolume(true);
    const toastId = addToast('loading', 'Creating volume', newVolName.trim(), 0);
    try {
        const options: Record<string, string> = {};
        if (newVolPath.trim()) {
            options.type = 'none';
            options.o = 'bind';
            options.device = newVolPath.trim();
        }

        const res = await fetch('/api/volumes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: newVolName.trim(),
                options: Object.keys(options).length > 0 ? options : undefined
            })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to create volume');
        }

        updateToast(toastId, 'success', 'Volume created', newVolName.trim());
        setIsCreateOpen(false);
        setNewVolName('');
        setNewVolPath('');
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create volume';
        updateToast(toastId, 'error', 'Create failed', message);
    } finally {
        setCreatingVolume(false);
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

    const getVisiblePorts = (container: Container) => {
        if (!container.Ports || container.Ports.length === 0) return [];
        if (container.PodName && !container.isInfra) return [];
        return container.Ports;
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

    const drawerNode = drawerContainer?.nodeName && drawerContainer.nodeName !== 'Local'
        ? drawerContainer.nodeName
        : drawerContainer
            ? 'Local'
            : null;

    const logsPanelData: ContainerLogsPanelData | null = drawerContainer
        ? {
            id: drawerContainer.Id,
            name: drawerContainer.Names[0]?.replace(/^\/+/, '') || drawerContainer.Id,
            image: drawerContainer.Image,
            state: drawerContainer.State,
            status: drawerContainer.Status,
            created: drawerContainer.Created,
            ports: drawerContainer.Ports,
            mounts: drawerContainer.Mounts as ContainerLogsPanelData['mounts'],
            hideMeta: true,
        }
        : null;

    return (
        <div className="h-full flex flex-col relative">
            <ConfirmModal
                isOpen={!!volumeToDelete}
                title="Delete Volume"
                message={`Delete volume "${volumeToDelete?.Name ?? ''}"? This cannot be undone.`}
                confirmText="Delete"
                isDestructive
                onConfirm={handleDeleteVolume}
                onCancel={() => setVolumeToDelete(null)}
            />
              <PageHeader title="Container Engine" showBack={false} helpId="container-engine">
                        <div className="flex flex-col gap-3 w-full md:flex-row md:items-center">
                            <div className="relative flex-1 min-w-[200px]">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                                <input
                                    type="text"
                                    placeholder={activeTab === 'containers' ? 'Search containers...' : 'Search volumes...'}
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="w-full pl-9 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                                />
                            </div>
                            {activeTab === 'containers' ? (
                                <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 select-none">
                                    <input
                                        type="checkbox"
                                        checked={showInfra}
                                        onChange={(e) => setShowInfra(e.target.checked)}
                                        className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                                    />
                                    Show infrastructure containers
                                </label>
                            ) : (
                                <div className="flex flex-wrap items-center justify-end gap-3 w-full md:w-auto">
                                    <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 select-none">
                                        <input
                                            type="checkbox"
                                            checked={showSystemVolumes}
                                            onChange={(e) => setShowSystemVolumes(e.target.checked)}
                                            className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500"
                                        />
                                        Show system volumes
                                    </label>
                                    <button
                                        onClick={() => setIsCreateOpen(true)}
                                        className="flex items-center justify-center w-10 h-10 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors shadow-sm"
                                        title="Create volume"
                                        aria-label="Create volume"
                                    >
                                        <Plus size={18} />
                                    </button>
                                </div>
                            )}
                        </div>
                    </PageHeader>

            <div className="px-4 md:px-6 border-b border-gray-200 dark:border-gray-800">
                <div className="flex gap-1">
                    {(['containers', 'volumes'] as ContainerEngineTab[]).map((tab) => (
                        <button
                            key={tab}
                            onClick={() => handleTabChange(tab)}
                            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                                activeTab === tab
                                    ? 'border-blue-600 text-blue-600 dark:text-blue-400'
                                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                            }`}
                        >
                            {tab === 'containers' ? 'Containers' : 'Volumes'}
                        </button>
                    ))}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
                {activeTab === 'containers' ? (
                    loading ? (
                        <PluginLoading message="Connecting to Agent..." />
                    ) : waitingForSync ? (
                        <PluginLoading message="Synchronizing state..." />
                    ) : filteredContainers.length === 0 ? (
                        <div className="text-center text-gray-500 dark:text-gray-400 mt-10">
                            {containers.length > 0 ? 'No containers match your filters.' : 'No active containers found.'}
                        </div>
                    ) : (
                        <div className="space-y-6">
                            {sortedGroups.map(group => (
                                <div key={group} className="bg-gray-50/60 dark:bg-gray-900/30 border border-gray-200 dark:border-gray-800 rounded-xl p-4">
                                    <div className="flex items-center gap-2 mb-4 pb-2 border-b border-gray-200 dark:border-gray-800">
                                        <Box className="text-indigo-500" size={18} />
                                        <h3 className="text-xs font-bold uppercase tracking-wider text-gray-600 dark:text-gray-300">{group}</h3>
                                        <span className="ml-auto text-[11px] font-mono bg-gray-200 dark:bg-gray-800 px-2 py-0.5 rounded-full text-gray-600 dark:text-gray-400">
                                            {groupedContainers[group].length} containers
                                        </span>
                                    </div>
                                    <div className="grid gap-3">
                                        {groupedContainers[group].map((c) => {
                                            const ports = getVisiblePorts(c);
                                            return (
                                                <div key={c.Id} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-3 hover:border-blue-200 dark:hover:border-blue-700 transition-colors">
                                                    <div className="flex flex-col md:flex-row md:items-center gap-3 justify-between">
                                                        <div className="flex items-center gap-3">
                                                            <span className={`w-2.5 h-2.5 rounded-full ${c.State === 'running' ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                                                            <div>
                                                                <div className="flex flex-wrap items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
                                                                    {c.Names[0].replace(/^\//, '')}
                                                                    {c.nodeName && (
                                                                        <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
                                                                            {c.nodeName}
                                                                        </span>
                                                                    )}
                                                                    {c.parent && (
                                                                        <span
                                                                            className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border truncate max-w-[180px] ${
                                                                                c.parent.type === 'service'
                                                                                    ? 'bg-purple-50 text-purple-700 dark:bg-purple-900/20 dark:text-purple-200 border-purple-200 dark:border-purple-800'
                                                                                    : 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-200 border-amber-200 dark:border-amber-800'
                                                                            }`}
                                                                            title={`${c.parent.type === 'service' ? 'Service' : 'Bundle'}: ${c.parent.name}`}
                                                                        >
                                                                            <span className="uppercase tracking-wide mr-1 text-[10px] opacity-80">
                                                                                {c.parent.type === 'service' ? 'Svc' : 'Bundle'}
                                                                            </span>
                                                                            <span className="font-mono text-[10px]">{c.parent.name}</span>
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <p className="text-xs text-gray-500 dark:text-gray-400">{c.Status}</p>
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-1.5">
                                                            <button
                                                                onClick={() => openLogs(c)}
                                                                className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded"
                                                                title="Logs & Info"
                                                            >
                                                                <Activity size={18} />
                                                            </button>
                                                            <button
                                                                onClick={() => openTerminal(c)}
                                                                className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 rounded"
                                                                title="Terminal"
                                                            >
                                                                <TerminalIcon size={18} />
                                                            </button>
                                                            <button
                                                                onClick={() => openActions(c)}
                                                                className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded"
                                                                title="Actions"
                                                            >
                                                                <MoreVertical size={18} />
                                                            </button>
                                                        </div>
                                                    </div>
                                                    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs sm:text-sm text-gray-600 dark:text-gray-400">
                                                        <div>
                                                            <p className="text-[11px] uppercase tracking-wide text-gray-500">Image</p>
                                                            <p className="break-all">{c.Image}</p>
                                                        </div>
                                                        <div>
                                                            <p className="text-[11px] uppercase tracking-wide text-gray-500">Network</p>
                                                            {c.IsHostNetwork ? (
                                                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-purple-700 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/20 px-2 py-0.5 rounded">
                                                                    Host Network
                                                                </span>
                                                            ) : (
                                                                <span>{c.NetworkMode || 'Default'}</span>
                                                            )}
                                                        </div>
                                                        {ports.length > 0 && (
                                                            <div className="md:col-span-2">
                                                                <p className="text-[11px] uppercase tracking-wide text-gray-500">Ports</p>
                                                                <div className="flex flex-wrap gap-1.5">
                                                                    {ports.map((p, index) => {
                                                                        const protocol = (p.protocol || 'tcp').toLowerCase();
                                                                        const display = p.hostPort && p.hostPort !== p.containerPort
                                                                            ? `${p.hostPort}:${p.containerPort}/${protocol}`
                                                                            : p.hostPort
                                                                                ? `${p.hostPort}/${protocol}`
                                                                                : `${p.containerPort}/${protocol}`;
                                                                        return (
                                                                            <span key={`${display}-${index}`} className="bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-[11px] font-mono border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300">
                                                                                {display}
                                                                            </span>
                                                                        );
                                                                    })}
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )
                ) : volumesLoading ? (
                    <PluginLoading message="Loading volumes..." />
                ) : visibleVolumes.length === 0 ? (
                    <div className="text-center text-gray-500 dark:text-gray-400 mt-10">
                        {showSystemVolumes ? 'No volumes detected on this node.' : 'No user-managed volumes. Enable system volumes to view all storage.'}
                    </div>
                ) : (
                    <div className="space-y-4">
                        {visibleVolumes.map((vol) => (
                            <div key={`${vol.Node}-${vol.Name}`} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                    <div>
                                        <div className="flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100">
                                            <HardDrive size={16} className="text-blue-500" />
                                            {vol.Name}
                                            {vol.Anonymous && (
                                                <span className="px-2 py-0.5 text-[11px] rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
                                                    System
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-gray-500 dark:text-gray-400">Driver: {vol.Driver}</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {vol.Node && (
                                            <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200 border border-blue-200 dark:border-blue-800">
                                                {vol.Node}
                                            </span>
                                        )}
                                        <button
                                            onClick={() => setVolumeToDelete(vol)}
                                            className="p-1.5 text-red-500 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                                            title="Delete volume"
                                        >
                                            <Trash2 size={18} />
                                        </button>
                                    </div>
                                </div>
                                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs sm:text-sm text-gray-600 dark:text-gray-400">
                                    <div>
                                        <p className="text-[11px] uppercase tracking-wide text-gray-500">Mountpoint</p>
                                        <p className="font-mono text-[13px] break-all">{vol.Mountpoint}</p>
                                    </div>
                                    <div>
                                        <p className="text-[11px] uppercase tracking-wide text-gray-500">Used By</p>
                                        {vol.UsedBy && vol.UsedBy.length > 0 ? (
                                            <div className="flex flex-wrap gap-1">
                                                {vol.UsedBy.map((consumer) => (
                                                    <span key={consumer.id} className="px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-[11px] text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-700">
                                                        {consumer.name}
                                                    </span>
                                                ))}
                                            </div>
                                        ) : (
                                            <span className="text-gray-400 italic">Unused</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {containerActionsOverlay}

            {isCreateOpen && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="w-full max-w-md bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-6 shadow-xl">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">Create Volume</h3>
                            <button onClick={closeCreateModal} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                                <X size={20} />
                            </button>
                        </div>
                        <form className="space-y-4" onSubmit={handleCreateVolume}>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Volume Name</label>
                                <input
                                    type="text"
                                    value={newVolName}
                                    onChange={(e) => setNewVolName(e.target.value)}
                                    className="w-full p-2 rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                                    placeholder="my-volume"
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Host Path (optional)</label>
                                <input
                                    type="text"
                                    value={newVolPath}
                                    onChange={(e) => setNewVolPath(e.target.value)}
                                    className="w-full p-2 rounded-md border border-gray-300 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
                                    placeholder="/path/on/host"
                                />
                                <p className="text-xs text-gray-500 mt-1">Bind to a host directory to convert it into a managed volume.</p>
                            </div>
                            <div className="flex justify-end gap-2 pt-2">
                                <button
                                    type="button"
                                    onClick={closeCreateModal}
                                    className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={creatingVolume}
                                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md disabled:opacity-50"
                                >
                                    {creatingVolume ? 'Creating...' : 'Create Volume'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {drawerMode && drawerContainer && (
                <div className="fixed inset-0 z-50 flex justify-end bg-gray-950/70 backdrop-blur-sm">
                    <div className="w-full max-w-5xl h-full bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl animate-in slide-in-from-right-10">
                        {drawerMode === 'logs' && logsPanelData ? (
                            <ContainerLogsPanel
                                container={logsPanelData}
                                nodeName={drawerNode ?? undefined}
                                onClose={closeDrawer}
                            />
                        ) : (
                            <div className="h-full flex flex-col bg-gray-950">
                                <div className="flex items-start justify-between px-6 py-4 border-b border-gray-800 bg-gray-900">
                                    <div>
                                        <p className="text-xs uppercase tracking-wider text-gray-500">Terminal</p>
                                        <div className="flex items-center gap-3 text-white text-lg font-semibold">
                                            <TerminalIcon size={18} />
                                            <span>{drawerContainer.Names[0]?.replace(/^\//, '') || drawerContainer.Id}</span>
                                            {/* Hide ID on embedded terminal header per UX request */}
                                        </div>
                                        {drawerNode && (
                                            <div className="mt-2 inline-flex items-center gap-2 text-xs text-gray-400">
                                                <span className="uppercase tracking-wide">Node</span>
                                                <span className="px-2 py-0.5 rounded-full bg-gray-800 text-gray-200 border border-gray-700">{drawerNode}</span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => terminalRef.current?.clear()}
                                            className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-gray-800"
                                            title="Clear terminal"
                                        >
                                            <Eraser size={18} />
                                        </button>
                                        <button
                                            onClick={() => terminalRef.current?.reconnect()}
                                            className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-gray-800"
                                            title="Reconnect"
                                        >
                                            <RefreshCw size={18} />
                                        </button>
                                        <button
                                            onClick={closeDrawer}
                                            className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-gray-800"
                                            title="Close"
                                        >
                                            <X size={18} />
                                        </button>
                                    </div>
                                </div>
                                <div className="flex-1 overflow-hidden">
                                    <DynamicTerminal
                                        ref={terminalRef}
                                        id={`container:${(drawerNode && drawerNode !== 'Local' ? drawerNode : 'local')}:${drawerContainer.Id}`}
                                        showControls={false}
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
