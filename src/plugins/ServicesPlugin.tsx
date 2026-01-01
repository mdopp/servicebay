'use client';

import { useState, useEffect } from 'react';
import { Plus, RefreshCw, Activity, Edit, Trash2, MoreVertical, PlayCircle, Power, RotateCw, Box, ArrowLeft, X, Search, Link as LinkIcon, Layers } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';
import { fetchTemplates } from '@/app/actions';
import { Template } from '@/lib/registry';
import PageHeader from '@/components/PageHeader';

interface Service {
  name: string;
  active: boolean;
  status: string;
  kubePath: string;
  yamlPath: string | null;
  ports: { host?: string; container: string }[];
  volumes: { host: string; container: string }[];
  type?: 'container' | 'link';
  url?: string;
  description?: string;
  id?: string;
  monitor?: boolean;
}

export default function ServicesPlugin() {
  const router = useRouter();
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { addToast, updateToast } = useToast();

  // New Service Modal State
  const [showNewModal, setShowNewModal] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  // Link Modal State
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [isEditingLink, setIsEditingLink] = useState(false);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [linkForm, setLinkForm] = useState({ name: '', url: '', description: '', monitor: false });

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/services');
      if (res.ok) setServices(await res.json());
    } catch (error) {
      console.error('Failed to fetch services', error);
      addToast('error', 'Failed to fetch services');
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

  const handleOpenNew = async () => {
    setShowNewModal(true);
    if (templates.length === 0) {
        setLoadingTemplates(true);
        try {
            const data = await fetchTemplates();
            setTemplates(data);
        } catch (e) {
            console.error(e);
        } finally {
            setLoadingTemplates(false);
        }
    }
  };

  const handleEditLink = (service: Service) => {
    setLinkForm({
        name: service.name,
        url: service.url || '',
        description: service.description || '',
        monitor: service.monitor || false
    });
    setIsEditingLink(true);
    setEditingLinkId(service.name);
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
                    onClick={handleOpenNew}
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
                                </h3>
                                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                                    {service.type === 'link' ? (
                                        <a href={service.url} target="_blank" rel="noopener noreferrer" className="hover:underline hover:text-blue-600 transition-colors">
                                            {service.url}
                                        </a>
                                    ) : (
                                        service.status
                                    )}
                                </div>
                            </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                            {service.type === 'link' ? (
                                <>
                                    <button onClick={() => handleEditLink(service)} className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors" title="Edit">
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

      {/* New Service Modal */}
      {showNewModal && (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-2xl border border-gray-200 dark:border-gray-800 flex flex-col max-h-[80vh]">
                <div className="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-800">
                    <h3 className="text-lg font-bold">Create New Service</h3>
                    <button onClick={() => setShowNewModal(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                        <X size={20} />
                    </button>
                </div>
                
                <div className="p-4 overflow-y-auto">
                    <div className="grid gap-4">
                        {/* Manual */}
                        <button 
                            onClick={() => router.push('/create')}
                            className="flex items-center gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-500 dark:hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all text-left group"
                        >
                            <div className="p-3 bg-blue-100 dark:bg-blue-900/30 rounded-lg text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform">
                                <Edit size={24} />
                            </div>
                            <div>
                                <h4 className="font-bold text-gray-900 dark:text-white">Manual Service</h4>
                                <p className="text-sm text-gray-500 dark:text-gray-400">Create a service from scratch using YAML/Kube definitions.</p>
                            </div>
                        </button>

                        {/* Link */}
                        <button 
                            onClick={() => { 
                                setShowNewModal(false); 
                                setLinkForm({ name: '', url: '', description: '', monitor: false });
                                setIsEditingLink(false);
                                setEditingLinkId(null);
                                setShowLinkModal(true); 
                            }}
                            className="flex items-center gap-4 p-4 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-purple-500 dark:hover:border-purple-500 hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-all text-left group"
                        >
                            <div className="p-3 bg-purple-100 dark:bg-purple-900/30 rounded-lg text-purple-600 dark:text-purple-400 group-hover:scale-110 transition-transform">
                                <LinkIcon size={24} />
                            </div>
                            <div>
                                <h4 className="font-bold text-gray-900 dark:text-white">Link Existing Service</h4>
                                <p className="text-sm text-gray-500 dark:text-gray-400">Add a shortcut to an external service running on this server.</p>
                            </div>
                        </button>

                        <div className="border-t border-gray-200 dark:border-gray-800 my-2"></div>
                        <h4 className="text-sm font-medium text-gray-500 dark:text-gray-400 px-2">Stacks & Templates</h4>

                        {/* Templates */}
                        {loadingTemplates ? (
                            <div className="p-8 text-center text-gray-500">Loading templates...</div>
                        ) : (
                            <div className="grid gap-2">
                                {templates.slice(0, 5).map(template => (
                                    <button 
                                        key={template.name}
                                        onClick={() => router.push(`/create?template=${template.name}`)}
                                        className="flex items-center gap-3 p-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
                                    >
                                        <div className="p-2 bg-gray-100 dark:bg-gray-800 rounded text-gray-600 dark:text-gray-400">
                                            <Layers size={18} />
                                        </div>
                                        <div className="flex-1">
                                            <div className="font-medium text-gray-900 dark:text-white">{template.name}</div>
                                            <div className="text-xs text-gray-500 dark:text-gray-400 capitalize">{template.type}</div>
                                        </div>
                                    </button>
                                ))}
                                <button 
                                    onClick={() => router.push('/registry')}
                                    className="p-3 text-center text-sm text-blue-600 dark:text-blue-400 hover:underline"
                                >
                                    View all templates in Registry
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
      )}

      {/* Link Modal */}
      {showLinkModal && (
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md border border-gray-200 dark:border-gray-800">
                <div className="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-800">
                    <h3 className="text-lg font-bold">Add External Link</h3>
                    <button onClick={() => setShowLinkModal(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                        <X size={20} />
                    </button>
                </div>
                <div className="p-4 space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                        <input 
                            type="text" 
                            value={linkForm.name}
                            onChange={e => setLinkForm({...linkForm, name: e.target.value})}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="e.g. Home Assistant"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">URL</label>
                        <input 
                            type="url" 
                            value={linkForm.url}
                            onChange={e => setLinkForm({...linkForm, url: e.target.value})}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="http://192.168.1.10:8123"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Description (Optional)</label>
                        <input 
                            type="text" 
                            value={linkForm.description}
                            onChange={e => setLinkForm({...linkForm, description: e.target.value})}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                            placeholder="Smart Home Control"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <input 
                            type="checkbox" 
                            id="monitor"
                            checked={linkForm.monitor}
                            onChange={e => setLinkForm({...linkForm, monitor: e.target.checked})}
                            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <label htmlFor="monitor" className="text-sm text-gray-700 dark:text-gray-300">
                            Monitor this service (HTTP Check)
                        </label>
                    </div>
                </div>
                <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 rounded-b-xl">
                    <button 
                        onClick={() => setShowLinkModal(false)}
                        className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={handleSaveLink}
                        className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors font-medium"
                    >
                        Add Link
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
}
