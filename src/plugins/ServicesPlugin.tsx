'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
// import yaml from 'js-yaml'; // Import YAML parser for Strict Matching
import { logger } from '@/lib/logger';
import { useDigitalTwin } from '@/hooks/useDigitalTwin'; // V4 Hook
import PluginLoading from '@/components/PluginLoading';
// We keep Service interface but recreate it or import from shared data if it matches?
// SharedData Service is a complex UI object. digital twin ServiceUnit is simple.
// WE NEED TO MAP TWIN -> UI SERVICE here.
import { Plus, RefreshCw, Activity, Edit, Trash2, MoreVertical, PlayCircle, Power, RotateCw, Box, ArrowLeft, Search, X, AlertCircle, FileCode, FileText, ArrowRight } from 'lucide-react';

// Define/Import UI Service Type locally or keep using legacy type if compatible
// Let's redefine locally to be explicit about V4 structure or map to it.
interface Service {
  name: string;
  id?: string;
  active: boolean; // activeState == 'active'
  status: string; // subState
  activeState: string; 
  subState: string;
  kubePath: string; // path
  yamlPath: string | null;
  ports: { host?: string; container: string }[];
  volumes: { host: string; container: string }[];
  type?: 'container' | 'link' | 'gateway' | 'kube' | 'pod';
  url?: string;
  description?: string;
  monitor?: boolean;
  labels?: Record<string, string>;
  verifiedDomains?: string[];
  hostNetwork?: boolean;
  nodeName?: string;
  // Gateway specific
  externalIP?: string;
  uptime?: number;
  internalIP?: string;
  dnsServers?: string[];
}

import { useRouter } from 'next/navigation';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import PageHeader from '@/components/PageHeader';
import ExternalLinkModal from '@/components/ExternalLinkModal';
import ActionProgressModal from '@/components/ActionProgressModal';

/**
 * ServicesPlugin
 * 
 * The main dashboard plugin for managing systemd/Quadlet services.
 * Features:
 * - List services from all nodes
 * - Start/Stop/Restart control
 * - "Migrate Unmanaged" wizard for converting raw pods to Quadlet
 * - External Link and Gateway management
 */
interface DiscoveredService {
    serviceName: string;
    containerNames: string[];
    containerIds: string[];
    podId?: string;
    unitFile?: string;
    sourcePath?: string;
    status: 'managed' | 'unmanaged';
    type: 'kube' | 'container' | 'pod' | 'compose' | 'other';
    nodeName?: string;
}

interface MigrationPlan {
    filesToCreate: string[];
    filesToBackup: string[];
    servicesToStop: string[];
    targetName: string;
    backupDir: string;
}

export default function ServicesPlugin() {
  const router = useRouter();
  // removed services, filteredServices state
  const [filteredServices, setFilteredServices] = useState<Service[]>([]);
  const [discoveredServices, setDiscoveredServices] = useState<DiscoveredService[]>([]);
  // removed loading
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState<Service | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedForMerge, setSelectedForMerge] = useState<string[]>([]);
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeName, setMergeName] = useState('');
  const [migrationPlan, setMigrationPlan] = useState<MigrationPlan | null>(null);
  const [migrationModalOpen, setMigrationModalOpen] = useState(false);
  const [selectedForMigration, setSelectedForMigration] = useState<DiscoveredService | null>(null);
  const [migrationName, setMigrationName] = useState('');
  // removed nodes
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [hasDiscovered, setHasDiscovered] = useState(false);
  const [migrating, setMigrating] = useState(false);
  // removed refreshing, isFetchingRef
  const { addToast, updateToast } = useToast();

  // Action Progress Modal
  const [actionService, setActionService] = useState<Service | null>(null);
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [currentAction, setCurrentAction] = useState<'start' | 'stop' | 'restart'>('start');

  // Link Modal State
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [linkForm, setLinkForm] = useState<{ name: string; url: string; description: string; monitor: boolean; ip_targets?: string }>({ name: '', url: '', description: '', monitor: false, ip_targets: '' });
  
  const { data: twin, isConnected, lastUpdate } = useDigitalTwin();
  
  // Replaced Legacy Hooks with Twin Logic
  // const { data: servicesData, loading: servicesLoading, validating: servicesValidating, refresh: refreshServices } = useServicesList();
  // const { data: graphData, loading: graphLoading, validating: graphValidating, refresh: refreshGraph } = useNetworkGraph();
  
  const { services } = useMemo(() => {
    if (!twin || !twin.nodes) return { services: [], nodes: [] };

    console.log("twin:", twin);
    logger.debug('ServicesPlugin', 'Computing services from Twin', { nodeCount: Object.keys(twin.nodes).length });

    // 1. Extract Nodes
    const nodeList = Object.keys(twin.nodes).map(name => ({ Name: name, Addr: '0.0.0.0' }));

    const servicesList: Service[] = [];

    Object.entries(twin.nodes).forEach(([nodeName, nodeState]) => {
         const fileKeys = Object.keys(nodeState.files);
         
         nodeState.services.forEach(unit => {
             const baseName = unit.name.replace('.service', '');
             const isManaged = !!unit.isManaged;
             
             // Filter: Only show Managed services
             if (!isManaged) {
                // Also check if it's the gateway or proxy which might be special
                // If it is NOT managed, we still want to show it if it's the proxy or ServiceBay itself.
                // We rely on the Backend (Agent V4) to flag these via Source-Centric Truth.
                if (unit.isReverseProxy || unit.isServiceBay) {
                   // allow
                } else {
                   return;
                }
             }

             // --- RAW DATA LINKING (Single Source of Truth) ---
             // We link the Systemd Service to its Podman Container to get runtime stats.
             
             // 1. Determine Yaml Path (Static Definition, not guessing)
             let yamlPath: string | null = null;
             if (isManaged) {
                 // STRICT: The Quadlet file must match the service Base Name.
                 // Since isManaged=true means it IS a .kube service (Agent V4 definition), we search for .kube
                 const filePath = fileKeys.find(f => f.endsWith(`/${baseName}.kube`));

                 if (filePath) {
                     yamlPath = filePath; 
                     
                     // For Kube, we want the actual YAML file referenced
                     const file = nodeState.files[filePath];
                     if (file && file.content) {
                          const match = file.content.match(/^Yaml=(.+)$/m);
                          if (match) {
                              const yamlFile = match[1].trim();
                              const yamlKey = fileKeys.find(k => k.endsWith(`/${yamlFile}`));
                              if (yamlKey) {
                                  yamlPath = yamlKey;
                              }
                          }
                     }
                 }
             } else {
                 // Unmanaged: Check for direct YAML existence
                 const fallbackYaml = fileKeys.find(f => f.endsWith(`/${baseName}.yml`) || f.endsWith(`/${baseName}.yaml`));
                 if (fallbackYaml) {
                     yamlPath = fallbackYaml;
                 }
             }

             // 2. Find Container
             let container = undefined;
             
             // STRICT: Only use Explicit Link from Backend (Agent V4.1+)
             // We do NOT guess based on names. If Agent V4 hasn't linked it, it's not linked.
             if (unit.associatedContainerIds && unit.associatedContainerIds.length > 0) {
                 container = nodeState.containers.find(c => unit.associatedContainerIds?.includes(c.id));
             }

             // Find Verified Domains via Proxy State (Source of Truth)
             // V4.1: Use Enriched Data from Backend (TwinStore)
             const verifiedDomains = unit.verifiedDomains || [];

             // Prepare Runtime Data from Container (Source of Truth)
             // eslint-disable-next-line @typescript-eslint/no-explicit-any
             const rawContainer = container as any;
             
             // 1. Ports (Prefer direct Twin data)
             let ports = [];
             if (unit.ports && unit.ports.length > 0) {
                 ports = unit.ports.map(p => ({
                    host: p.hostPort ? String(p.hostPort) : '',
                    container: p.containerPort ? String(p.containerPort) : ''
                 }));
             } else {
                 // Fallback to container linkage (Legacy)
                 ports = rawContainer?.ports?.map((p: { hostPort?: string | number, containerPort?: string | number }) => ({
                    host: p.hostPort ? String(p.hostPort) : '',
                    container: p.containerPort ? String(p.containerPort) : ''
                 })) || [];
             }

             // 2. Labels
             const labels = { ...rawContainer?.labels };
             if (unit.isReverseProxy) labels['servicebay.role'] = 'reverse-proxy';
             if (unit.isServiceBay) labels['servicebay.role'] = 'system';

             // 3. Name & Description overrides
             let displayName = unit.name;
             if (unit.isReverseProxy) displayName = 'Reverse Proxy (Nginx)';
             else if (unit.isServiceBay) displayName = 'ServiceBay System';

             const svc: Service = {
                 id: unit.name,
                 name: displayName,
                 nodeName: nodeName,
                 description: unit.description,
                 active: unit.activeState === 'active',
                 status: unit.activeState,
                 activeState: unit.activeState,
                 subState: unit.subState,
                 kubePath: unit.path,
                 yamlPath: yamlPath,
                 type: isManaged ? 'kube' : 'container',
                 ports: ports,
                 volumes: [], // Todo: Map container mounts if needed
                 monitor: false,
                 labels: labels,
                 verifiedDomains: verifiedDomains
             };
             
             if (twin.proxy?.routes) {
                 const route = twin.proxy.routes.find(r => r.targetService === baseName);
                 if (route) {
                     svc.url = `https://${route.host}`;
                 }
             }
             
             servicesList.push(svc);
         });
    });

    // Deduplicate Services (merge aliases like nginx-web and nginx)
    const uniqueServices = new Map<string, Service>();
    servicesList.forEach(s => {
        const key = `${s.nodeName}:${s.name}`;
        const existing = uniqueServices.get(key);
        if (!existing) {
            uniqueServices.set(key, s);
        } else {
            // Priority: Managed > Unmanaged, Active > Inactive
            const isNewManaged = s.type === 'kube';
            const isOldManaged = existing.type === 'kube';
            
            // If one is Managed and other isn't, prefer Managed
            if (isNewManaged && !isOldManaged) {
                uniqueServices.set(key, s);
                return;
            }
            if (isOldManaged && !isNewManaged) return;
            
            // If both same type, prefer Active
            if (s.active && !existing.active) {
                uniqueServices.set(key, s);
                return;
            }
            
            // If both active, prefer one with Yaml Path
            if (s.yamlPath && !existing.yamlPath) {
                uniqueServices.set(key, s);
            }
        }
    });

    // 2. Add Abstract Gateway Service (if not already present as a physical service)
    // We treat the Gateway (Router) as a service to ensure it appears in the list.
    const gatewayService: Service = {
        name: twin.gateway.provider === 'fritzbox' ? 'FritzBox Gateway' : 'Internet Gateway',
        id: 'gateway',
        nodeName: 'Global',
        description: 'Upstream Internet Connection',
        active: twin.gateway.upstreamStatus === 'up',
        status: twin.gateway.upstreamStatus === 'up' ? 'active' : 'inactive',
        activeState: twin.gateway.upstreamStatus === 'up' ? 'active' : 'inactive',
        subState: 'running',
        kubePath: '',
        yamlPath: null,
        type: 'gateway',
        ports: (twin.gateway.portMappings || []).map(p => ({
            host: String(p.hostPort), 
            container: String(p.containerPort)
        })),
        volumes: [],
        monitor: true,
        externalIP: twin.gateway.publicIp,
        internalIP: twin.gateway.internalIp,
        dnsServers: twin.gateway.dnsServers,
        uptime: twin.gateway.uptime
    };
    
    const finalServices = Array.from(uniqueServices.values());
    finalServices.push(gatewayService);

    return { services: finalServices, nodes: nodeList };
  }, [twin]);

  const loading = !isConnected && services.length === 0;

  const fetchData = () => {
     // Twin updates automatically
  };

  const discoverUnmanaged = async () => {
    if (!twin || !twin.nodes) return;
    setDiscoveryLoading(true);
    
    // Simulate async to show loading state briefy
    await new Promise(r => setTimeout(r, 300));

    try {
        const allDiscovery: DiscoveredService[] = [];
        
        Object.entries(twin.nodes).forEach(([nodeName, nodeState]) => {
            const fileKeys = Object.keys(nodeState.files);
            
            nodeState.services.forEach(unit => {
                const baseName = unit.name.replace('.service', '');
                // Check if Managed (already shown in main list)
                // STRICT: Only .kube files are considered "Managed".
                // .container files are considered "Unmanaged" (Legacy) and should be available for migration.
                const isManaged = fileKeys.some(f => f.endsWith(`/${baseName}.kube`));
                
                // ALSO Check if it's the Proxy which we force-show in the main list
                // This prevents "nginx-web" from appearing in both Lists if it is a legacy .container
                const isForcedProxy = (twin.proxy?.provider === 'nginx' && (unit.name === 'nginx-web.service' || unit.name === 'nginx.service'));

                // Filter out Infrastructure Services (like podman.service)
                const isInfra = unit.name === 'podman.service' || unit.name === 'podman.socket';

                if (!isManaged && !isForcedProxy && !isInfra && unit.activeState === 'active') {
                    // Try to identify relevant services (containers, or key system services)
                    const container = nodeState.containers.find(c => c.names.includes(baseName) || c.names.includes(unit.name) || unit.name.includes(c.id.substring(0, 12)));
                    
                    // Only show if it looks like a container service or has "container" in name
                    if (container || unit.name.startsWith('container-') || unit.description.includes('Podman') || unit.description.includes('Container')) {
                         allDiscovery.push({
                             serviceName: unit.name,
                             containerNames: container ? container.names : [],
                             containerIds: container ? [container.id] : [],
                             status: 'unmanaged',
                             type: 'container',
                             nodeName: nodeName,
                             sourcePath: unit.path,
                             // Optional fields
                             podId: undefined,
                             unitFile: undefined
                         });
                    }
                }
            });
        });
        
        setDiscoveredServices(allDiscovery);
        setHasDiscovered(true);
    } catch (error) {
      logger.error('ServicesPlugin', 'Failed to discover services', error);
    } finally {
      setDiscoveryLoading(false);
    }
  };

  useEffect(() => {
      let filtered = services;

      
      // Filter by Search
      if (searchQuery) {
          const q = searchQuery.toLowerCase();
          filtered = filtered.filter(s => 
              s.name.toLowerCase().includes(q) ||
              (s.description && s.description.toLowerCase().includes(q)) ||
              (s.nodeName && s.nodeName.toLowerCase().includes(q))
          );
      }
      
      setFilteredServices(filtered);
  }, [services, searchQuery]);

  const openMigrationModal = async (service: DiscoveredService) => {
      setSelectedForMigration(service);
      setMigrationName(service.serviceName.replace('.service', ''));
      setMigrationModalOpen(true);
      
      // Fetch Plan
      try {
          const query = service.nodeName && service.nodeName !== 'Local' ? `?node=${service.nodeName}` : '';
          const res = await fetch(`/api/system/discovery/migrate${query}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service, customName: service.serviceName.replace('.service', ''), dryRun: true })
          });
          if (res.ok) {
              const data = await res.json();
              setMigrationPlan(data.plan);
          }
      } catch (e) {
          logger.error('ServicesPlugin', 'Failed to fetch migration plan', e);
      }
  };

  const handleMigrate = async () => {
      if (!selectedForMigration) return;
      setMigrating(true);
      
      try {
          const query = selectedForMigration.nodeName && selectedForMigration.nodeName !== 'Local' ? `?node=${selectedForMigration.nodeName}` : '';
          const res = await fetch(`/api/system/discovery/migrate${query}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service: selectedForMigration, customName: migrationName })
          });
          
          if (!res.ok) throw new Error('Migration failed');
          
          addToast('success', `Service ${migrationName} migrated successfully`);
          setMigrationModalOpen(false);
          setMigrationPlan(null);
          fetchData();
      } catch {
          addToast('error', 'Failed to migrate service');
      } finally {
          setMigrating(false);
      }
  };

  const updateMigrationPlan = async (name: string) => {
      setMigrationName(name);
      if (!selectedForMigration) return;
      
      try {
          const query = selectedForMigration.nodeName && selectedForMigration.nodeName !== 'Local' ? `?node=${selectedForMigration.nodeName}` : '';
          const res = await fetch(`/api/system/discovery/migrate${query}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ service: selectedForMigration, customName: name, dryRun: true })
          });
          if (res.ok) {
              const data = await res.json();
              setMigrationPlan(data.plan);
          }
      } catch (e) {
          logger.error('ServicesPlugin', 'Failed to fetch migration plan', e);
      }
  };

  const openMergeModal = async () => {
      setMergeModalOpen(true);
      setMergeName('');
      setMigrationPlan(null);
  };

  const updateMergePlan = async (name: string) => {
      setMergeName(name);
      if (selectedForMerge.length < 2 || !name) return;

      const servicesToMerge = discoveredServices.filter(s => selectedForMerge.includes(s.serviceName));
      
      try {
          const nodeName = servicesToMerge[0]?.nodeName;
          const query = nodeName && nodeName !== 'Local' ? `?node=${nodeName}` : '';
          const res = await fetch(`/api/system/discovery/merge${query}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ services: servicesToMerge, newName: name, dryRun: true })
          });
          if (res.ok) {
              const data = await res.json();
              setMigrationPlan(data.plan);
          }
      } catch (e) {
          logger.error('ServicesPlugin', 'Failed to fetch merge plan', e);
      }
  };

  const handleMerge = async () => {
      if (selectedForMerge.length < 2) return;
      if (!mergeName) {
          addToast('error', 'Please enter a name for the new service');
          return;
      }

      const servicesToMerge = discoveredServices.filter(s => selectedForMerge.includes(s.serviceName));
      
      try {
          const nodeName = servicesToMerge[0]?.nodeName;
          const query = nodeName && nodeName !== 'Local' ? `?node=${nodeName}` : '';
          const res = await fetch(`/api/system/discovery/merge${query}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ services: servicesToMerge, newName: mergeName })
          });
          
          if (!res.ok) {
              const data = await res.json();
              throw new Error(data.error || 'Merge failed');
          }
          
          addToast('success', `Services merged into ${mergeName} successfully`);
          setMergeModalOpen(false);
          setSelectedForMerge([]);
          setMergeName('');
          setMigrationPlan(null);
          fetchData();
      } catch (error: unknown) {
          const message = error instanceof Error ? error.message : 'Failed to merge services';
          addToast('error', message);
      }
  };

  const toggleMergeSelection = (serviceName: string) => {
      if (selectedForMerge.includes(serviceName)) {
          setSelectedForMerge(selectedForMerge.filter(s => s !== serviceName));
      } else {
          setSelectedForMerge([...selectedForMerge, serviceName]);
      }
  };

  // SSE Effect removed - Twin handles updates.
  /*
  useEffect(() => {
    // Setup SSE for real-time updates
    const eventSource = new EventSource('/api/stream');
    
    eventSource.onmessage = (event) => {
      // ...
    };

    return () => {
      eventSource.close();
    };
  }, []);
  */

  const handleEditLink = (service: Service) => {
    setLinkForm({
        name: service.name,
        url: service.url || '',
        description: service.description || '',
        monitor: service.monitor || false
    });
    setIsEditingLink(true);
    setEditingLinkId(service.name); // Or service.id if available and consistent
    setShowLinkModal(true);
  };

  const handleSaveLink = async () => {
    if (!linkForm.name || !linkForm.url) {
        addToast('error', 'Name and URL are required');
        return;
    }

    try {
        const method = isEditingLink ? 'PUT' : 'POST';
        const url = isEditingLink ? `/api/services/${editingLinkId}` : '/api/services';

        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...linkForm, type: 'link' })
        });

        if (!res.ok) throw new Error('Failed to save link');

        addToast('success', isEditingLink ? 'Link updated successfully' : 'Link added successfully');
        setShowLinkModal(false);
        setLinkForm({ name: '', url: '', description: '', monitor: false });
        setIsEditingLink(false);
        setEditingLinkId(null);
        fetchData();
    } catch {
        addToast('error', 'Failed to save link');
    }
  };

  const confirmDelete = (service: Service) => {
    setServiceToDelete(service);
    setDeleteModalOpen(true);
  };

  const handleDelete = async () => {
    if (!serviceToDelete) return;
    setDeleteModalOpen(false);
    
    const toastId = addToast('loading', 'Deleting service...', `Removing ${serviceToDelete.name}`, 0);

    try {
        const serviceName = serviceToDelete.id || serviceToDelete.name;
        const nodeParam = serviceToDelete.nodeName === 'Local' ? '' : serviceToDelete.nodeName;
        const query = nodeParam ? `?node=${nodeParam}` : '';
        const res = await fetch(`/api/services/${serviceName}${query}`, { method: 'DELETE' });
        if (res.ok) {
            updateToast(toastId, 'success', 'Service deleted', `Service ${serviceToDelete.name} has been removed.`);
            fetchData();
        } else {
            const data = await res.json();
            updateToast(toastId, 'error', 'Delete failed', data.error);
        }
    } catch {
        updateToast(toastId, 'error', 'Delete failed', 'An unexpected error occurred.');
    }
  };

  const openActions = (service: Service) => {
    setSelectedService(service);
    setShowActions(true);
  };

  const handleAction = async (action: string) => {
    if (!selectedService) return;
    
    // Intercept start, stop, restart actions to show progress modal
    if (action === 'start' || action === 'stop' || action === 'restart') {
        setActionService(selectedService);
        setCurrentAction(action);
        setActionModalOpen(true);
        setShowActions(false);
        return;
    }

    setActionLoading(true);
    
    const toastId = addToast('loading', 'Action in progress', `Executing ${action} on ${selectedService.name}...`, 0);

    try {
        const serviceName = selectedService.id || selectedService.name;
        const nodeParam = selectedService.nodeName === 'Local' ? '' : selectedService.nodeName;
        const query = nodeParam ? `?node=${nodeParam}` : '';
        const res = await fetch(`/api/services/${serviceName}/action${query}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        
        if (!res.ok) {
            const data = await res.json();
            updateToast(toastId, 'error', 'Action failed', data.error);
        } else {
            setShowActions(false);
            updateToast(toastId, 'success', 'Action initiated', `${action} command sent to ${selectedService.name}`);
            // Wait a bit for the action to take effect
            setTimeout(fetchData, 1000);
        }
    } catch (e) {
        logger.error('ServicesPlugin', 'Action failed', e);
        updateToast(toastId, 'error', 'Action failed', 'An unexpected error occurred.');
    } finally {
        setActionLoading(false);
    }
  };

  // filteredServices is already computed in useEffect

  return (
    <div className="h-full flex flex-col relative">
      <ConfirmModal 
        isOpen={deleteModalOpen}
        title="Delete Service"
        message={`Are you sure you want to delete service "${serviceToDelete?.name}"? This action cannot be undone.`}
        confirmText="Delete"
        isDestructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteModalOpen(false)}
      />

      {actionService && (
        <ActionProgressModal
            isOpen={actionModalOpen}
            onClose={() => setActionModalOpen(false)}
            serviceName={actionService.id || actionService.name}
            nodeName={actionService.nodeName}
            action={currentAction}
            onComplete={() => {
                fetchData();
                const actionPast = currentAction === 'stop' ? 'stopped' : currentAction === 'start' ? 'started' : 'restarted';
                addToast('success', `Service ${actionPast} successfully`);
            }}
        />
      )}
      <PageHeader 
        title="Services" 
        showBack={false} 
        helpId="services"
        actions={
            <>
                <button 
                    onClick={() => router.push('/registry')}
                    className="flex items-center gap-2 bg-blue-600 text-white p-2 rounded hover:bg-blue-700 shadow-sm transition-colors text-sm font-medium"
                    title="New Service"
                >
                    <Plus size={18} />
                </button>
            </>
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

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
            <PluginLoading message="Loading services..." subMessage="Waiting for agent synchronization..." />
        ) : filteredServices.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center">
                 <div className="bg-slate-50 dark:bg-slate-900 rounded-full p-6 mb-4">
                     <Box size={48} className="text-slate-300 dark:text-slate-600" />
                 </div>
                 <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100 mb-2">
                     {services.length > 0 ? 'No Matching Services' : 'No Managed Services Found'}
                 </h3>
                 <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm mb-6">
                     {services.length > 0 
                       ? `No services match "${searchQuery}". Try a different search term.`
                       : "ServiceBay couldn't find any Quadlet-managed services running on your nodes."}
                 </p>
                 
                 {/* Debug Info for troubleshooting why list is empty */}
                 {services.length === 0 && (
                     <div className="text-left text-xs text-slate-400 bg-slate-100 dark:bg-slate-950 p-4 rounded-lg border border-slate-200 dark:border-slate-800 font-mono w-full max-w-md overflow-x-auto">
                        <p className="font-bold mb-2">Debug Information:</p>
                        <ul className="space-y-1">
                            <li>Twin Status: {isConnected ? 'Connected' : 'Disconnected'}</li>
                            <li>Last Update: {new Date(lastUpdate).toLocaleTimeString()}</li>
                            {Object.entries(twin?.nodes || {}).map(([name, state]) => (
                                <li key={name} className="mt-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                                    <strong>Node: {name}</strong><br/>
                                    - Raw Services: {state.services.length}<br/>
                                    - Files: {Object.keys(state.files).length}<br/>
                                    - Containers: {state.containers.length}
                                </li>
                            ))}
                        </ul>
                        <p className="mt-2 italic opacity-75">
                            Note: ServiceBay filters services to only show those managed by Quadlet (matching .container/.kube files) or explicit system services.
                        </p>
                     </div>
                 )}
            </div>
        ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-6 auto-rows-fr">
                {filteredServices.map((service) => {
                    // Pre-calculate deduped ports similar to Network Plugin
                    const dedupedPorts = (() => {
                        const uniquePortsMap = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
                        service.ports.forEach(p => {
                            const key = `${p.host || '_'}:${p.container}`;
                            if (!uniquePortsMap.has(key)) {
                                uniquePortsMap.set(key, p);
                            }
                        });
                        return Array.from(uniquePortsMap.values());
                    })();

                    return (
                        <div key={`${service.nodeName || 'local'}-${service.name}`} className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 hover:shadow-md transition-all duration-200 relative overflow-hidden flex flex-col h-full min-w-0">
                            {/* Header Row */}
                            <div className="flex items-start gap-4 justify-between mb-4">
                                <div className="flex items-start gap-3 flex-1 min-w-0">
                                    {/* Status Dot */}
                                    <div className={`mt-1.5 w-3 h-3 shrink-0 rounded-full ${service.active ? 'bg-green-500' : 'bg-red-500'}`} title={service.status} />
                                    
                                    <div className="flex-1 min-w-0">
                                        <div className="flex flex-wrap items-center gap-2 mb-1">
                                            <h3 className="font-bold text-lg text-gray-900 dark:text-gray-100 truncate" title={service.name}>
                                                {service.name.replace('.service', '')}
                                            </h3>
                                            
                                            {/* Badges */}
                                            {service.nodeName && service.nodeName !== 'Local' && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded">
                                                    {service.nodeName}
                                                </span>
                                            )}
                                            {service.type === 'link' && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-cyan-100 dark:bg-cyan-900/40 text-cyan-700 dark:text-cyan-400 border border-cyan-200 dark:border-cyan-800 rounded">
                                                    External Link
                                                </span>
                                            )}
                                            {service.type === 'gateway' && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400 border border-orange-200 dark:border-orange-800 rounded">
                                                    Gateway
                                                </span>
                                            )}
                                            {service.labels && service.labels['servicebay.role'] === 'reverse-proxy' && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800 rounded">
                                                    Reverse Proxy
                                                </span>
                                            )}
                                            {service.labels && service.labels['servicebay.role'] === 'system' && (
                                                <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800 rounded">
                                                    System
                                                </span>
                                            )}
                                            
                                            {/* IP Badge */}
                                            {service.externalIP && service.type !== 'gateway' && (
                                                 <span className="text-[10px] font-mono font-bold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-1.5 py-0.5 rounded">
                                                    IP: {service.externalIP}
                                                 </span>
                                            )}
                                        </div>
                                        
                                        {/* Description removed as requested */}
                                    </div>
                                </div>
                                
                                {/* Actions */}
                                <div className="flex items-center gap-1 shrink-0 ml-auto bg-gray-50 dark:bg-gray-800/50 p-1 rounded-lg border border-gray-100 dark:border-gray-800">
                                    {service.type === 'gateway' ? (
                                        <>
                                            <Link href="/monitor/gateway" className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded transition-colors" title="Monitor Gateway">
                                                <Activity size={16} />
                                            </Link>
                                            <Link href="/registry?selected=gateway" className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors" title="Edit Gateway">
                                                <Edit size={16} />
                                            </Link>
                                        </>
                                    ) : service.type === 'link' ? (
                                        <>
                                            <button onClick={() => handleEditLink(service)} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors" title="Edit Link">
                                                <Edit size={16} />
                                            </button>
                                            <button onClick={() => confirmDelete(service)} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors" title="Delete">
                                                <Trash2 size={16} />
                                            </button>
                                        </>
                                    ) : (
                                        <>
                                            <Link href={`/monitor/${service.id || service.name}${service.nodeName && service.nodeName !== 'Local' ? `?node=${service.nodeName}` : ''}`} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded transition-colors" title="Monitor">
                                                <Activity size={16} />
                                            </Link>
                                            {service.type === 'kube' ? (
                                                <Link href={`/edit/${service.id || service.name}${service.nodeName && service.nodeName !== 'Local' ? `?node=${service.nodeName}` : ''}`} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors" title="Edit Configuration">
                                                    <Edit size={16} />
                                                </Link>
                                            ) : (
                                                <div className="p-1.5 text-gray-300 dark:text-gray-700 cursor-not-allowed opacity-50" title="Not Managed via Quadlet Kube">
                                                    <Edit size={16} />
                                                </div>
                                            )}
                                            <button onClick={() => openActions(service)} className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/30 rounded transition-colors" title="Actions">
                                                <MoreVertical size={16} />
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                            
                            {/* Compact Details Grid */}
                            <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-4 bg-gray-50/50 dark:bg-gray-800/20 rounded-md p-3 border border-gray-100 dark:border-gray-800/50 flex-1">
                                {service.type === 'gateway' ? (
                                    <>
                                        <div className="flex flex-col">
                                            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Ext IP</span>
                                            <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.externalIP || 'N/A'}</span>
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Int IP</span>
                                            <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.internalIP || 'N/A'}</span>
                                        </div>
                                        <div className="flex flex-col">
                                            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Uptime</span>
                                            <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.uptime ? `${Math.floor(service.uptime / 3600)}h` : 'N/A'}</span>
                                        </div>
                                        {service.dnsServers && (
                                            <div className="flex flex-col col-span-2">
                                                <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">DNS Servers</span>
                                                <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{service.dnsServers.join(', ')}</span>
                                            </div>
                                        )}
                                    </>
                                ) : service.type === 'link' ? (
                                    <div className="col-span-full">
                                        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold block">Target URL</span>
                                         <a href={service.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline break-all">
                                            {service.url}
                                        </a>
                                    </div>
                                ) : (
                                    <>
                                        {/* State removed as requested */}
                                        {service.verifiedDomains && service.verifiedDomains.length > 0 && (
                                            <div className="flex flex-col col-span-2">
                                                <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Domains</span>
                                                <div className="flex flex-wrap gap-1 mt-0.5">
                                                    {service.verifiedDomains.map(d => (
                                                        <a 
                                                            key={d} 
                                                            href={d.startsWith('http') ? d : `https://${d}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="text-xs font-mono text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-1.5 py-0.5 rounded hover:underline"
                                                        >
                                                            {d}
                                                        </a>
                                                    ))}
                                                </div>
                                            </div>
                                        )}

                                        {/* Host Mode indicator removed as requested */}
                                    </>
                                )}
                            </div>

                            {/* Footer: Tags Row */}
                            <div className="flex flex-wrap items-center gap-4 pt-3 border-t border-gray-100 dark:border-gray-800/50 mt-auto">
                                {/* Ports */}
                                {dedupedPorts.length > 0 && (
                                    <div className="flex gap-2 items-center text-sm">
                                        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Ports:</span>
                                        <div className="flex flex-wrap gap-1.5">
                                            {dedupedPorts.map((p, i) => {
                                                const display = p.host ? `:${p.host}` : `${p.container}/tcp`;
                                                return (
                                                <a 
                                                    key={i} 
                                                    href={p.host ? `http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${p.host}` : '#'}
                                                    target={p.host ? "_blank" : undefined}
                                                    rel="noopener noreferrer"
                                                    className={`px-2 py-0.5 rounded text-xs font-mono border transition-colors ${
                                                        p.host 
                                                        ? 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer' 
                                                        : 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800/30 cursor-default'
                                                    }`}
                                                    title={p.container ? `Container Port: ${p.container}` : 'Host Port'}
                                                    onClick={(e) => !p.host && e.preventDefault()}
                                                >
                                                    {display}
                                                </a>
                                            )})}
                                        </div>
                                    </div>
                                )}

                                {/* Volumes (Collapsed/Minimal) */}
                                {service.volumes && service.volumes.length > 0 && (
                                    <div className="flex gap-2 items-center text-sm ml-auto">
                                        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Volumes:</span>
                                        <span className="text-xs bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700" title={service.volumes.map(v => `${v.host} -> ${v.container}`).join('\n')}>
                                            {service.volumes.length}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        )}

        {/* Unmanaged Services Section */}
        <div className="mt-12 border-t border-gray-200 dark:border-gray-800 pt-8">
            <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold flex items-center gap-2 text-orange-600 dark:text-orange-400">
                    <AlertCircle size={20} />
                    Unmanaged Services
                    {hasDiscovered && ` (${discoveredServices.filter(s => s.status === 'unmanaged').length})`}
                </h2>
                {selectedForMerge.length > 1 && (
                    <button 
                        onClick={openMergeModal}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm rounded-lg flex items-center gap-2 transition-colors shadow-sm"
                    >
                        <Box size={16} />
                        Merge Selected ({selectedForMerge.length})
                    </button>
                )}
            </div>

            {!hasDiscovered ? (
                <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-8 text-center border border-gray-200 dark:border-gray-800">
                    <p className="text-gray-600 dark:text-gray-400 mb-4">
                        Scan your system for running containers that are not yet managed by ServiceBay.
                    </p>
                    <button
                        onClick={discoverUnmanaged}
                        disabled={discoveryLoading}
                        className="px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg inline-flex items-center gap-2 transition-colors disabled:opacity-50"
                    >
                        {discoveryLoading ? <RefreshCw className="animate-spin" size={18} /> : <Search size={18} />}
                        {discoveryLoading ? 'Scanning...' : 'Discover Unmanaged Services'}
                    </button>
                </div>
            ) : discoveredServices.filter(s => s.status === 'unmanaged').length === 0 ? (
                <div className="bg-gray-50 dark:bg-gray-900/50 rounded-lg p-8 text-center border border-gray-200 dark:border-gray-800">
                    <p className="text-gray-500 dark:text-gray-400">No unmanaged services found.</p>
                    <button
                        onClick={discoverUnmanaged}
                        className="mt-4 text-sm text-blue-600 hover:underline"
                    >
                        Scan Again
                    </button>
                </div>
            ) : (
                <div className="grid gap-4">
                    {discoveredServices.filter(s => s.status === 'unmanaged').map((service) => (
                        <div key={service.serviceName} className={`bg-white dark:bg-gray-900 border rounded-lg p-4 hover:shadow-md transition-all duration-200 ${selectedForMerge.includes(service.serviceName) ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-gray-200 dark:border-gray-800'}`}>
                            <div className="flex justify-between items-start mb-3">
                                <div className="flex items-start gap-3">
                                    <input 
                                        type="checkbox" 
                                        checked={selectedForMerge.includes(service.serviceName)}
                                        onChange={() => toggleMergeSelection(service.serviceName)}
                                        className="mt-1.5 w-4 h-4 text-indigo-600 rounded border-gray-300 focus:ring-indigo-500"
                                    />
                                    <div>
                                        <h3 className="font-bold text-lg break-all">{service.serviceName}</h3>
                                        <div className="flex gap-2 flex-wrap">
                                            <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 mt-1">
                                                Type: {service.type}
                                            </span>
                                            {service.nodeName && (
                                                <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 mt-1">
                                                    Node: {service.nodeName}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                                <button 
                                    onClick={() => openMigrationModal(service)}
                                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg flex items-center gap-1 transition-colors"
                                >
                                    Migrate <ArrowRight size={16} />
                                </button>
                            </div>

                            <div className="ml-7 space-y-2 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 p-3 rounded-lg">
                                <div className="flex gap-2">
                                    <Box size={16} className="shrink-0 mt-0.5" />
                                    <div className="flex flex-wrap gap-1">
                                        {service.containerNames.map(c => (
                                            <span key={c} className="bg-gray-200 dark:bg-gray-700 px-1.5 rounded text-xs text-gray-800 dark:text-gray-200">
                                                {c}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                                {service.sourcePath ? (
                                    <div className="flex gap-2 break-all">
                                        <FileCode size={16} className="shrink-0 mt-0.5" />
                                        <span className="font-mono text-xs">{service.sourcePath}</span>
                                    </div>
                                ) : service.unitFile && (
                                    <div className="flex gap-2 break-all">
                                        <FileCode size={16} className="shrink-0 mt-0.5" />
                                        <span className="font-mono text-xs">{service.unitFile}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
      </div>

      {/* Migration Modal */}
      {migrationModalOpen && selectedForMigration && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-2xl border border-gray-200 dark:border-gray-800 p-6 max-h-[90vh] overflow-y-auto">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-lg font-bold">Migrate Service</h3>
                    <button onClick={() => setMigrationModalOpen(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="space-y-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Service Name
                        </label>
                        <input
                            type="text"
                            value={migrationName}
                            onChange={(e) => updateMigrationPlan(e.target.value)}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                            This will be the name of the systemd service and the pod.
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Source
                        </label>
                        {selectedForMigration.sourcePath || selectedForMigration.unitFile ? (
                            <a 
                                href={`/view?path=${encodeURIComponent(selectedForMigration.sourcePath || selectedForMigration.unitFile || '')}&node=${encodeURIComponent(selectedForMigration.nodeName || 'Local')}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-sm text-blue-600 hover:underline flex items-center gap-1 w-fit"
                            >
                                <FileText size={14} />
                                {selectedForMigration.sourcePath || selectedForMigration.unitFile}
                            </a>
                        ) : selectedForMigration.podId ? (
                            <div className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1">
                                <Box size={14} />
                                <span>Running Pod (ID: {selectedForMigration.podId.substring(0, 12)})</span>
                                <span className="text-xs text-gray-500 ml-1">(Source file not found)</span>
                            </div>
                        ) : (
                            <div className="text-sm text-red-600 flex items-center gap-1">
                                <AlertCircle size={14} />
                                <span>No source file or running pod found. Cannot migrate.</span>
                            </div>
                        )}
                    </div>

                    <details className="mt-4 text-xs text-gray-400">
                        <summary className="cursor-pointer hover:text-gray-600">Debug Info</summary>
                        <pre className="mt-2 p-2 bg-gray-100 dark:bg-gray-900 rounded overflow-auto max-h-32">
                            {JSON.stringify(selectedForMigration, null, 2)}
                        </pre>
                    </details>

                    {migrationPlan ? (
                        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 space-y-4 border border-gray-200 dark:border-gray-700">
                            <h4 className="font-semibold text-sm text-gray-900 dark:text-gray-100 flex items-center gap-2">
                                <FileCode size={16} /> Migration Plan
                            </h4>
                            
                            {migrationPlan.backupDir && (
                                <div className="text-sm">
                                    <span className="text-amber-600 dark:text-amber-400 font-medium">Backup: </span>
                                    <span className="text-gray-600 dark:text-gray-400">Existing files will be backed up to </span>
                                    <code className="text-xs bg-gray-200 dark:bg-gray-800 px-1 py-0.5 rounded">{migrationPlan.backupDir}</code>
                                </div>
                            )}

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Files to Create</span>
                                    <ul className="mt-2 space-y-1">
                                        {migrationPlan.filesToCreate.map(f => (
                                            <li key={f} className="text-sm text-green-600 dark:text-green-400 flex items-center gap-2">
                                                <Plus size={14} /> {f}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                                
                                {migrationPlan.servicesToStop.length > 0 && (
                                    <div>
                                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Services to Stop</span>
                                        <ul className="mt-2 space-y-1">
                                            {migrationPlan.servicesToStop.map(s => (
                                                <li key={s} className="text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
                                                    <Power size={14} /> {s}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="flex justify-center py-8">
                            <RefreshCw className="animate-spin text-blue-500" />
                        </div>
                    )}
                </div>

                <div className="flex justify-end gap-3 mt-8">
                    <button 
                        onClick={() => setMigrationModalOpen(false)}
                        className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={handleMigrate}
                        disabled={!migrationName || !migrationPlan || (!selectedForMigration.sourcePath && !selectedForMigration.unitFile && !selectedForMigration.podId) || migrating}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center gap-2"
                    >
                        {migrating ? (
                            <>
                                <RefreshCw className="animate-spin" size={16} />
                                Migrating...
                            </>
                        ) : (
                            'Confirm Migration'
                        )}
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Merge Modal */}
      {mergeModalOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-2xl border border-gray-200 dark:border-gray-800 p-6 max-h-[90vh] overflow-y-auto">
                <div className="flex justify-between items-center mb-6">
                    <h3 className="text-lg font-bold">Merge Services</h3>
                    <button onClick={() => setMergeModalOpen(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="space-y-6">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            New Service Name
                        </label>
                        <input
                            type="text"
                            value={mergeName}
                            onChange={(e) => updateMergePlan(e.target.value)}
                            placeholder="e.g. my-app-stack"
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 focus:ring-2 focus:ring-blue-500 outline-none"
                            autoFocus
                        />
                    </div>
                    
                    <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded text-xs font-mono text-gray-600 dark:text-gray-400 max-h-32 overflow-y-auto">
                        <div className="font-semibold mb-2">Selected Services:</div>
                        {selectedForMerge.map(s => (
                            <div key={s}>• {s}</div>
                        ))}
                    </div>

                    {migrationPlan && (
                        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 space-y-4 border border-gray-200 dark:border-gray-700">
                            <h4 className="font-semibold text-sm text-gray-900 dark:text-gray-100 flex items-center gap-2">
                                <FileCode size={16} /> Merge Plan
                            </h4>
                            
                            {migrationPlan.backupDir && (
                                <div className="text-sm">
                                    <span className="text-amber-600 dark:text-amber-400 font-medium">Backup: </span>
                                    <span className="text-gray-600 dark:text-gray-400">Existing files will be backed up to </span>
                                    <code className="text-xs bg-gray-200 dark:bg-gray-800 px-1 py-0.5 rounded">{migrationPlan.backupDir}</code>
                                </div>
                            )}

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Files to Create</span>
                                    <ul className="mt-2 space-y-1">
                                        {migrationPlan.filesToCreate.map(f => (
                                            <li key={f} className="text-sm text-green-600 dark:text-green-400 flex items-center gap-2">
                                                <Plus size={14} /> {f}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                                
                                {migrationPlan.servicesToStop.length > 0 && (
                                    <div>
                                        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Services to Stop</span>
                                        <ul className="mt-2 space-y-1">
                                            {migrationPlan.servicesToStop.map(s => (
                                                <li key={s} className="text-sm text-red-600 dark:text-red-400 flex items-center gap-2">
                                                    <Power size={14} /> {s}
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex justify-end gap-3 mt-8">
                    <button 
                        onClick={() => setMergeModalOpen(false)}
                        className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={handleMerge}
                        disabled={!mergeName || !migrationPlan}
                        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                    >
                        Merge & Migrate
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Actions Overlay */}
      {showActions && selectedService && (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-md border border-gray-200 dark:border-gray-800 p-6">
                <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center gap-4">
                        <button onClick={() => setShowActions(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1 text-sm font-medium">
                            <ArrowLeft size={18} />
                            Back
                        </button>
                        <h3 className="text-lg font-bold">Service Actions</h3>
                    </div>
                    <button onClick={() => setShowActions(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="mb-6">
                    <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg mb-4">
                        <Box className="text-blue-500" />
                        <div>
                            <div className="font-medium">{selectedService.name}</div>
                            <div className="text-xs text-gray-500 font-mono">Systemd Service</div>
                        </div>
                    </div>
                </div>

                <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                        <button 
                            onClick={() => handleAction('start')}
                            disabled={actionLoading}
                            className="flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                            <PlayCircle size={18} className="text-green-500" />
                            <span className="font-medium">Start</span>
                        </button>
                        <button 
                            onClick={() => handleAction('stop')}
                            disabled={actionLoading}
                            className="flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                        >
                            <Power size={18} className="text-red-500" />
                            <span className="font-medium">Stop</span>
                        </button>
                    </div>
                    
                    <button 
                        onClick={() => handleAction('restart')}
                        disabled={actionLoading}
                        className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                        <RotateCw size={18} className="text-blue-500" />
                        <span className="font-medium">Restart Service</span>
                    </button>

                    <button 
                        onClick={() => handleAction('update')}
                        disabled={actionLoading}
                        className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                    >
                        <RefreshCw size={18} className="text-orange-500" />
                        <span className="font-medium">Update & Restart</span>
                    </button>

                    <button 
                        onClick={() => {
                            setShowActions(false);
                            if (selectedService) confirmDelete(selectedService);
                        }}
                        disabled={actionLoading}
                        className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors text-red-600 dark:text-red-400"
                    >
                        <Trash2 size={18} />
                        <span className="font-medium">Delete Service</span>
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Link Modal */}
      <ExternalLinkModal 
        isOpen={showLinkModal}
        onClose={() => setShowLinkModal(false)}
        onSave={handleSaveLink}
        isEditing={isEditingLink}
        form={linkForm}
        setForm={setLinkForm}
      />

    </div>
  );
}
