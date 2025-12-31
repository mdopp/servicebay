'use client';

import { useState, useEffect } from 'react';
import { Plus, RefreshCw, Activity, Edit, Trash2, MoreVertical, PlayCircle, Power, RotateCw, Box, ArrowLeft, X, Github } from 'lucide-react';
import Link from 'next/link';
import ConfirmModal from '@/components/ConfirmModal';
import { useToast } from '@/providers/ToastProvider';

interface Service {
  name: string;
  active: boolean;
  status: string;
  kubePath: string;
  yamlPath: string | null;
  ports: { host?: string; container: string }[];
  volumes: { host: string; container: string }[];
}

export default function ServicesPlugin() {
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedService, setSelectedService] = useState<Service | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [serviceToDelete, setServiceToDelete] = useState<string | null>(null);
  const { addToast } = useToast();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmDelete = (name: string) => {
    setServiceToDelete(name);
    setDeleteModalOpen(true);
  };

  const handleDelete = async () => {
    if (!serviceToDelete) return;
    setDeleteModalOpen(false);
    
    try {
        const res = await fetch(`/api/services/${serviceToDelete}`, { method: 'DELETE' });
        if (res.ok) {
            addToast('success', 'Service deleted', `Service ${serviceToDelete} has been removed.`);
            fetchData();
        } else {
            const data = await res.json();
            addToast('error', 'Delete failed', data.error);
        }
    } catch {
        addToast('error', 'Delete failed', 'An unexpected error occurred.');
    }
  };

  const openActions = (service: Service) => {
    setSelectedService(service);
    setShowActions(true);
  };

  const handleAction = async (action: string) => {
    if (!selectedService) return;
    setActionLoading(true);
    try {
        const res = await fetch(`/api/services/${selectedService.name}/action`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        
        if (!res.ok) {
            const data = await res.json();
            addToast('error', 'Action failed', data.error);
        } else {
            setShowActions(false);
            addToast('success', 'Action initiated', `${action} command sent to ${selectedService.name}`);
            // Wait a bit for the action to take effect
            setTimeout(fetchData, 1000);
        }
    } catch (e) {
        console.error('Action failed', e);
        addToast('error', 'Action failed', 'An unexpected error occurred.');
    } finally {
        setActionLoading(false);
    }
  };

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
      <div className="flex justify-between items-center mb-6 p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Managed Services</h2>
        <div className="flex gap-2">
            <button onClick={fetchData} className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" title="Refresh">
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
            <Link href="/registry" className="flex items-center gap-2 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-700 px-3 py-2 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors text-sm font-medium">
                <Github size={18} /> Registry
            </Link>
            <Link href="/create" className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded hover:bg-blue-700 shadow-sm transition-colors text-sm font-medium">
                <Plus size={18} /> New Service
            </Link>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
            <div className="text-center text-gray-500 mt-10">Loading services...</div>
        ) : services.length === 0 ? (
            <div className="text-center text-gray-500 mt-10">No services found. Create one to get started.</div>
        ) : (
            <div className="grid gap-4">
                {services.map((service) => (
                <div key={service.name} className="group bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 hover:shadow-md transition-all duration-200">
                    <div className="flex flex-col md:flex-row md:items-center gap-4 justify-between">
                        <div className="flex items-center gap-3">
                            <div className={`w-3 h-3 rounded-full ${service.active ? 'bg-green-500' : 'bg-red-500'}`} />
                            <div>
                                <h3 className="font-bold text-lg text-gray-900 dark:text-gray-100">{service.name}</h3>
                                <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">{service.status}</div>
                            </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                            <Link href={`/monitor/${service.name}`} className="p-2 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors" title="Monitor">
                                <Activity size={18} />
                            </Link>
                            <Link href={`/edit/${service.name}`} className="p-2 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors" title="Edit">
                                <Edit size={18} />
                            </Link>
                            <button onClick={() => openActions(service)} className="p-2 text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded transition-colors" title="Actions">
                                <MoreVertical size={18} />
                            </button>
                        </div>
                    </div>
                    
                    {/* Details */}
                    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-gray-600 dark:text-gray-400">
                        {service.ports.length > 0 && (
                            <div>
                                <span className="font-semibold block mb-1">Ports:</span>
                                <div className="flex flex-wrap gap-1">
                                    {service.ports.map((p, i) => (
                                        <span key={i} className="bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded text-xs font-mono">
                                            {p.host ? `${p.host}:` : ''}{p.container}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}
                        {service.volumes.length > 0 && (
                            <div>
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
    </div>
  );
}
