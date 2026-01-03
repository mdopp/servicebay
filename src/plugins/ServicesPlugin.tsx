'use client';

import { useState, useEffect } from 'react';
import { Plus, RefreshCw, Activity, Edit, Trash2, MoreVertical, PlayCircle, Power, RotateCw, Box, ArrowLeft, Search, X, AlertCircle, FileCode, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import PageHeader from '@/components/PageHeader';
import ExternalLinkModal from '@/components/ExternalLinkModal';

interface DiscoveredService {
    serviceName: string;
    containerNames: string[];
    unitFile?: string;
    sourcePath?: string;
    status: 'managed' | 'unmanaged';
    type: 'kube' | 'container' | 'pod' | 'compose' | 'other';
}

interface Service {
  name: string;
  active: boolean;
  status: string;
  kubePath: string;
  yamlPath: string | null;
  ports: { host?: string; container: string }[];
  volumes: { host: string; container: string }[];
  type?: 'container' | 'link' | 'gateway';
  url?: string;
  description?: string;
  id?: string;
  monitor?: boolean;
  labels?: Record<string, string>;
  verifiedDomains?: string[];
}

export default function ServicesPlugin() {
  const router = useRouter();
  const [services, setServices] = useState<Service[]>([]);
  const [discoveredServices, setDiscoveredServices] = useState<DiscoveredService[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { addToast, updateToast } = useToast();

  // Link Modal State
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [linkForm, setLinkForm] = useState({ name: '', url: '', description: '', monitor: false });

  const fetchData = async () => {
    setLoading(true);
    try {
      const [servicesRes, discoveryRes] = await Promise.all([
        fetch('/api/services'),
        fetch('/api/system/discovery')
      ]);
      
      if (servicesRes.ok) setServices(await servicesRes.json());
      if (discoveryRes.ok) setDiscoveredServices(await discoveryRes.json());
    } catch (error) {
      console.error('Failed to fetch services', error);
      addToast('error', 'Failed to fetch services');
    } finally {
      setLoading(false);
    }
  };

  const handleMigrate = async (service: DiscoveredService) => {
      try {
          const res = await fetch('/api/system/discovery/migrate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(service)
          });
          
          if (!res.ok) throw new Error('Migration failed');
          
          addToast('success', `Service ${service.serviceName} migrated successfully`);
          fetchData();
      } catch (_error) {
          addToast('error', 'Failed to migrate service');
      }
  };

  useEffect(() => {
    fetchData();

    // Setup SSE for real-time updates
    const eventSource = new EventSource('/api/stream');
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'config' || data.type === 'container') {
           // Refresh data on change
           // We use a small debounce/delay because file writes might be atomic/multi-step
           // or systemd might take a moment to reflect status
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

  const confirmDelete = (name: string) => {
    setServiceToDelete(name);
    setDeleteModalOpen(true);
  };

  const handleDelete = async () => {
    if (!serviceToDelete) return;
    setDeleteModalOpen(false);
    
    const toastId = addToast('loading', 'Deleting service...', `Removing ${serviceToDelete}`, 0);

    try {
        const res = await fetch(`/api/services/${serviceToDelete}`, { method: 'DELETE' });
        if (res.ok) {
            updateToast(toastId, 'success', 'Service deleted', `Service ${serviceToDelete} has been removed.`);
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
    setActionLoading(true);
    
    const toastId = addToast('loading', 'Action in progress', `Executing ${action} on ${selectedService.name}...`, 0);

    try {
        const res = await fetch(`/api/services/${selectedService.name}/action`, {
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
        console.error('Action failed', e);
        updateToast(toastId, 'error', 'Action failed', 'An unexpected error occurred.');
    } finally {
        setActionLoading(false);
    }
  };

  const filteredServices = services.filter(s => 
    s.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="h-full flex flex-col relative">
      <ConfirmModal 
        isOpen={deleteModalOpen}
        title="Delete Service"
        message={`Are you sure you want to delete service "${serviceToDelete}"? This action cannot be undone.`}
        confirmText="Delete"
        isDestructive
        onConfirm={handleDelete}
        onCancel={() => setDeleteModalOpen(false)}
      />
      <div className="flex flex-col gap-4 mb-6 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <PageHeader title="Managed Services" showBack={false} helpId="services">
            <div className="flex gap-2">
                <button onClick={fetchData} className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" title="Refresh">
                    <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                </button>
                <button 
                    onClick={() => router.push('/registry')}
                    className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded hover:bg-blue-700 shadow-sm transition-colors text-sm font-medium"
                >
                    <Plus size={18} /> New
                </button>
            </div>
        </PageHeader>
        <div className="relative px-4 pb-4">
            <Search className="absolute left-7 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input 
                type="text" 
                placeholder="Search services..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
            />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
            <div className="text-center text-gray-500 mt-10">Loading services...</div>
        ) : filteredServices.length === 0 ? (
            <div className="text-center text-gray-500 mt-10">
                {services.length > 0 ? 'No services match your search.' : 'No services found. Create one to get started.'}
            </div>
        ) : (
            <div className="grid gap-4">
                {filteredServices.map((service) => (
                <div key={service.name} className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 hover:shadow-md transition-all duration-200">
                    <div className="flex flex-col md:flex-row md:items-center gap-4 justify-between">
                        <div className="flex items-center gap-3">
                            <div className={`w-3 h-3 rounded-full ${service.active ? 'bg-green-500' : 'bg-red-500'}`} title={service.status} />
                            <div>
                                <h3 className="font-bold text-lg text-gray-900 dark:text-gray-100 flex items-center gap-2">
                                    {service.name}
                                    {service.type === 'link' && <span className="text-xs font-normal px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-gray-500">Link</span>}
                                    {service.type === 'gateway' && <span className="text-xs font-normal px-2 py-0.5 bg-amber-100 dark:bg-amber-900/30 rounded text-amber-600 dark:text-amber-400">Gateway</span>}
                                    {service.labels && service.labels['podcli.role'] === 'reverse-proxy' && <span className="text-xs font-normal px-2 py-0.5 bg-green-100 dark:bg-green-900/30 rounded text-green-600 dark:text-green-400">Reverse Proxy</span>}
                                </h3>
                                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                                    {service.type === 'link' ? (
                                        <a href={service.url} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-blue-600 transition-colors">
                                            {service.url}
                                        </a>
                                    ) : service.type === 'gateway' ? (
                                        <div className="flex flex-col gap-1">
                                            <span>{service.description}</span>
                                            {service.verifiedDomains && service.verifiedDomains.length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-1">
                                                    {service.verifiedDomains.map(d => (
                                                        <a key={d} href={`https://${d}`} target="_blank" rel="noopener noreferrer" className="text-[10px] bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-1.5 py-0.5 rounded hover:underline">
                                                            {d}
                                                        </a>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        service.status
                                    )}
                                </div>
                            </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                            {service.type === 'gateway' ? (
                                <Link href="/registry?selected=gateway" className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors" title="Edit Gateway">
                                    <Edit size={18} />
                                </Link>
                            ) : service.type === 'link' ? (
                                <>
                                    <button onClick={() => handleEditLink(service)} className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors" title="Edit Link">
                                        <Edit size={18} />
                                    </button>
                                    <button onClick={() => confirmDelete(service.name)} className="p-2 text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors" title="Delete">
                                        <Trash2 size={18} />
                                    </button>
                                </>
                            ) : (
                                <>
                                    <Link href={`/monitor/${service.name}`} className="p-2 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors" title="Monitor">
                                        <Activity size={18} />
                                    </Link>
                                    <Link href={`/edit/${service.name}`} className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors" title="Edit">
                                        <Edit size={18} />
                                    </Link>
                                    <button onClick={() => openActions(service)} className="p-2 text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded transition-colors" title="Actions">
                                        <MoreVertical size={18} />
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    
                    {/* Details */}
                    <div className="mt-4 flex flex-wrap gap-4 text-sm text-gray-600 dark:text-gray-400">
                        {service.description && (
                            <div className="w-full text-gray-500 italic">
                                {service.description}
                            </div>
                        )}
                        
                        {service.type !== 'link' && (
                            <>
                                {service.ports.length > 0 && (
                                    <div className="flex-1 min-w-[250px]">
                                        <span className="font-semibold block mb-1">Ports:</span>
                                        <div className="flex flex-wrap gap-1">
                                            {service.ports.map((p, i) => (
                                                <span key={i} className="bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded text-xs font-mono">
                                                    {p.host ? (
                                                        <a href={`http://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${p.host}`} target="_blank" rel="noopener noreferrer" className="hover:underline text-blue-600 dark:text-blue-400">
                                                            {p.host}:{p.container}
                                                        </a>
                                                    ) : (
                                                        p.container
                                                    )}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {service.volumes.length > 0 && (
                                    <div className="flex-1 min-w-[250px]">
                                        <span className="font-semibold block mb-1">Volumes:</span>
                                        <div className="flex flex-col gap-1">
                                            {service.volumes.map((v, i) => (
                                                <span key={i} className="truncate text-xs font-mono" title={`${v.host} -> ${v.container}`}>
                                                    {v.host} → {v.container}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
                ))}
            </div>
        )}

        {/* Unmanaged Services Section */}
        {discoveredServices.filter(s => s.status === 'unmanaged').length > 0 && (
            <div className="mt-12 border-t border-gray-200 dark:border-gray-800 pt-8">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2 text-orange-600 dark:text-orange-400">
                    <AlertCircle size={20} />
                    Unmanaged Services ({discoveredServices.filter(s => s.status === 'unmanaged').length})
                </h2>
                <div className="grid gap-4">
                    {discoveredServices.filter(s => s.status === 'unmanaged').map((service) => (
                        <div key={service.serviceName} className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 hover:shadow-md transition-all duration-200">
                            <div className="flex justify-between items-start mb-3">
                                <div>
                                    <h3 className="font-bold text-lg break-all">{service.serviceName}</h3>
                                    <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 mt-1">
                                        Type: {service.type}
                                    </span>
                                </div>
                                <button 
                                    onClick={() => handleMigrate(service)}
                                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg flex items-center gap-1 transition-colors"
                                >
                                    Migrate <ArrowRight size={16} />
                                </button>
                            </div>

                            <div className="space-y-2 text-sm text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 p-3 rounded-lg">
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
                                {service.sourcePath && (
                                    <div className="flex gap-2 break-all">
                                        <FileCode size={16} className="shrink-0 mt-0.5" />
                                        <span className="font-mono text-xs">{service.sourcePath}</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        )}
      </div>

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
                            confirmDelete(selectedService.name);
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
