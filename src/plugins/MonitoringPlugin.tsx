'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Activity, Plus, RefreshCw, CheckCircle, XCircle, AlertTriangle, Play, Edit, Trash2, X, History, Search } from 'lucide-react';
import { useToast, ToastType } from '@/providers/ToastProvider';
import { Socket } from 'socket.io-client';
import PageHeader from '@/components/PageHeader';
import { Autocomplete } from '@/components/Autocomplete';
import ConfirmModal from '@/components/ConfirmModal';
import { CheckConfig, CheckType } from '@/lib/monitoring/types';
import { getNodes } from '@/app/actions/nodes';
import { PodmanConnection } from '@/lib/nodes';

// Extended type for UI
interface Check extends CheckConfig {
  status: 'ok' | 'fail' | 'unknown';
  lastRun: string | null;
  lastResult: string | null;
  message?: string; // Add optional message property
  history: { status: 'ok' | 'fail'; latency: number; timestamp: string }[];
}

interface Container {
  Id: string;
  Names: string[];
  Image: string;
}

interface HistoryItem {
  status: 'ok' | 'fail';
  latency: number;
  timestamp: string;
  message?: string;
}

export default function MonitoringPlugin() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [systemServices, setSystemServices] = useState<string[]>([]);
  const [managedServices, setManagedServices] = useState<string[]>([]);
  // const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [checkToDelete, setCheckToDelete] = useState<string | null>(null);
  const [editingCheck, setEditingCheck] = useState<CheckConfig | null>(null);
  const [historyCheck, setHistoryCheck] = useState<Check | null>(null);
  const [historyData, setHistoryData] = useState<HistoryItem[]>([]);
  const [timeRange, setTimeRange] = useState<'1h' | '24h' | '3d' | '2w'>('24h');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'ok' | 'fail' | 'unknown'>('all');
  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const isFetchingRef = useRef(false);
  const { addToast, updateToast } = useToast();
  // Using Digital Twin hook to trigger re-fetches when state changes?
  // Monitoring data is stored in `data/checks.json` in backend, NOT in twin directly.
  // HOWEVER, the backend runs the checks and emits events.
  // The original implementation used sockets directly.
  // 
  // Let's keep the manual `fetchData` but trigger it on 'monitoring:update' socket event which is still valid.
  // The user asked to remove "Updating data" notifications and refresh buttons.
  
  // Clean up socket listener logic to use the global socket hook if possible? 
  // Or just remove the toasts.

  // Still fetch from API because checks are server-side config
  const fetchData = useCallback(async () => {
    if (isFetchingRef.current) return;
    
    // Check cache (15s) unless forced
    // if (Date.now() - lastFetch < 15000) return; // disabled cache for now
    isFetchingRef.current = true;
    // if (!silent) setLoading(true); // Only show spinner on initial load
    
    try {
      const [checksRes, nodeList] = await Promise.all([
        fetch('/api/monitoring/checks'),
        getNodes()
      ]);
      
      if (checksRes.ok) setChecks(await checksRes.json());
      setNodes(nodeList);
    } catch (error) {
      console.error('Failed to fetch data', error);
      // addToast('error', 'Failed to fetch monitoring data'); // Suppress error toast on bg sync?
    } finally {
      // if (!silent) setLoading(false);
      isFetchingRef.current = false;
    }
  }, []); // Dependencies removed


  // Form state (restored)
  const [formData, setFormData] = useState<Partial<CheckConfig>>({
    name: '',
    type: 'http',
    target: '',
    interval: 60,
    enabled: true,
    nodeName: ''
  });

  // Fetch resources when node changes in form
  useEffect(() => {
    const fetchResources = async () => {
        if (!isModalOpen || !formData.nodeName) {
            setContainers([]);
            setManagedServices([]);
            setSystemServices([]);
            return;
        }

        setResourcesLoading(true);
        try {
            const query = `?node=${formData.nodeName}`;
            const [containersRes, servicesRes, systemRes] = await Promise.all([
                fetch(`/api/containers${query}`),
                fetch(`/api/services${query}`),
                fetch(`/api/system/services${query}`)
            ]);

            if (containersRes.ok) setContainers(await containersRes.json());
            if (servicesRes.ok) {
                const services = await servicesRes.json();
                setManagedServices(services.map((s: { name: string }) => s.name));
            }
            if (systemRes.ok) {
                const system = await systemRes.json();
                setSystemServices(system.map((s: { unit: string }) => s.unit));
            }
        } catch (e) {
            console.error('Failed to fetch node resources', e);
        } finally {
            setResourcesLoading(false);
        }
    };

    fetchResources();
  }, [isModalOpen, formData.nodeName]);

  useEffect(() => {
    fetchData(); // Initial load (not silent)

    // Request notification permission
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }

    let socket: Socket;

    // Listen for updates via socket
    const initSocket = async () => {
        const { io } = await import('socket.io-client');
        socket = io();
        
        socket.on('monitoring:alert', (data: { title: string, message: string, type: string }) => {
            // Toast removed/kept? "no notifications for updating data"
            // Alerts are important, keeping them.
            addToast(data.type as ToastType, data.title, data.message);
            
            // Only show native notification if page is hidden
            if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
                new Notification(data.title, { body: data.message });
            }
            
            // Refresh data on alert
            fetchData();
        });

        socket.on('monitoring:update', () => {
            // Silent update
            fetchData();
        });
    };
    
    initSocket();

    return () => {
        if (socket) socket.disconnect();
    };
  }, [fetchData, addToast]);

  const handleOpenModal = (check?: Check) => {
    if (check) {
      setEditingCheck(check);
      setFormData({
        name: check.name,
        type: check.type,
        target: check.target,
        interval: check.interval,
        enabled: check.enabled,
        nodeName: check.nodeName || '',
        httpConfig: check.httpConfig || { expectedStatus: 200, bodyMatchType: 'contains' }
      });
    } else {
      setEditingCheck(null);
      setFormData({
        name: '',
        type: 'http',
        target: '',
        interval: 60,
        enabled: true,
        nodeName: '',
        httpConfig: { expectedStatus: 200, bodyMatchType: 'contains' }
      });
    }
    setIsModalOpen(true);
  };

  const handleSave = async () => {
    try {
      const url = '/api/monitoring/checks';
      // const method = editingCheck ? 'PUT' : 'POST'; // Note: PUT not implemented in API yet, need to fix that
      const body = editingCheck ? { ...formData, id: editingCheck.id } : formData;

      // For now, POST handles both create and update in our simple store implementation if ID is present
      // But let's stick to POST for create. We need to update the API to handle updates properly.
      // Actually, the store.ts saveCheck handles updates if ID exists.
      // So we just need to make sure the API passes the ID through.
      
      const res = await fetch(url, {
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!res.ok) throw new Error('Failed to save check');

      addToast('success', `Check ${editingCheck ? 'updated' : 'created'} successfully`);
      setIsModalOpen(false);
      fetchData();
    } catch (error) {
      console.error(error);
      addToast('error', 'Failed to save check');
    }
  };

  const handleDelete = (id: string) => {
    setCheckToDelete(id);
    setIsDeleteModalOpen(true);
  };

  const confirmDelete = async () => {
    if (!checkToDelete) return;
    
    try {
        // We need a DELETE endpoint
        const res = await fetch(`/api/monitoring/checks?id=${checkToDelete}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete');
        addToast('success', 'Check deleted');
        fetchData();
    } catch {
        addToast('error', 'Failed to delete check');
    } finally {
        setIsDeleteModalOpen(false);
        setCheckToDelete(null);
    }
  };

  const handleRun = async (id: string) => {
    const toastId = addToast('loading', 'Running check...', 'Executing check immediately', 0);
    try {
        const res = await fetch(`/api/monitoring/checks/${id}/run`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed to run check');
        const result = await res.json();
        
        updateToast(toastId, result.status === 'ok' ? 'success' : 'error', 
            `Check ${result.status === 'ok' ? 'Passed' : 'Failed'}`, 
            result.message || `Latency: ${result.latency}ms`
        );
        fetchData();
    } catch {
        updateToast(toastId, 'error', 'Failed to run check', 'An unexpected error occurred');
    }
  };

  const handleShowHistory = async (check: Check) => {
    setHistoryCheck(check);
    setHistoryData([]); // Clear previous data
    try {
        const res = await fetch(`/api/monitoring/checks/${check.id}/history`);
        if (res.ok) {
            setHistoryData(await res.json());
        }
    } catch (error) {
        console.error('Failed to fetch history', error);
        addToast('error', 'Failed to fetch history');
    }
  };

  const filteredChecks = checks.filter(check => {
    const matchesSearch = 
        check.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
        check.target.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesStatus = statusFilter === 'all' || check.status === statusFilter;
    
    return matchesSearch && matchesStatus;
  });

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0">
      <PageHeader 
        title="Monitoring" 
        showBack={false} 
        helpId="monitoring"
        actions={
            <div className="flex gap-2 shrink-0">
                <button 
                    onClick={() => handleOpenModal()}
                    className="flex items-center gap-2 p-2 bg-blue-600 text-white rounded hover:bg-blue-700 shadow-sm transition-colors font-medium"
                    title="Add Check"
                >
                    <Plus className="w-4 h-4" />
                </button>
            </div>
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
      </div>

      <div className="flex-1 overflow-y-auto space-y-6 pb-6">
      {/* Stats Overview & Filters */}
      <div className="grid grid-cols-3 gap-2 px-2">
        <button 
            onClick={() => setStatusFilter(statusFilter === 'ok' ? 'all' : 'ok')}
            className={`p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'ok'
                ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 ring-2 ring-green-500 ring-opacity-50'
                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750'
            }`}
        >
            <div className="p-2 bg-green-500/10 rounded-lg mb-1">
              <CheckCircle className="w-5 h-5 text-green-500" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Healthy</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{checks.filter(c => c.status === 'ok').length}</p>
            </div>
        </button>
        <button 
            onClick={() => setStatusFilter(statusFilter === 'fail' ? 'all' : 'fail')}
            className={`p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'fail'
                ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 ring-2 ring-red-500 ring-opacity-50'
                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750'
            }`}
        >
            <div className="p-2 bg-red-500/10 rounded-lg mb-1">
              <XCircle className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Failing</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{checks.filter(c => c.status === 'fail').length}</p>
            </div>
        </button>
        <button 
            onClick={() => setStatusFilter(statusFilter === 'unknown' ? 'all' : 'unknown')}
            className={`p-3 rounded-xl border shadow-sm flex flex-col items-center text-center transition-all ${
                statusFilter === 'unknown'
                ? 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800 ring-2 ring-yellow-500 ring-opacity-50'
                : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-750'
            }`}
        >
            <div className="p-2 bg-yellow-500/10 rounded-lg mb-1">
              <AlertTriangle className="w-5 h-5 text-yellow-500" />
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500 dark:text-gray-400">Unknown</p>
              <p className="text-xl font-bold text-gray-900 dark:text-white">{checks.filter(c => c.status === 'unknown').length}</p>
            </div>
        </button>
      </div>



      {/* Checks List */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm mx-2">
        {filteredChecks.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {checks.length > 0 ? (
                <>
                    <Search className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>No checks match your filters.</p>
                    <button onClick={() => {setSearchQuery(''); setStatusFilter('all');}} className="mt-2 text-blue-600 dark:text-blue-400 hover:underline text-sm">
                        Clear filters
                    </button>
                </>
            ) : (
                <>
                    <Activity className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>No monitoring checks configured.</p>
                    <button onClick={() => handleOpenModal()} className="mt-4 text-blue-600 dark:text-blue-400 hover:underline text-sm">
                    Create your first check
                    </button>
                </>
            )}
          </div>
        ) : (
          <>
            <table className="w-full text-left hidden xl:table">
            <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400 text-sm">
              <tr>
                <th className="p-4">Name</th>
                <th className="p-4">Type</th>
                <th className="p-4">Target</th>
                <th className="p-4">Status</th>
                <th className="p-4">History</th>
                <th className="p-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
              {filteredChecks.map(check => (
                <tr key={check.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors">
                  <td className="p-4 font-medium text-gray-900 dark:text-white break-words whitespace-normal max-w-[150px]">{check.name}</td>
                  <td className="p-4">
                    <span className="px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded text-xs text-gray-600 dark:text-gray-300 uppercase border border-gray-200 dark:border-gray-700">
                      {check.type}
                    </span>
                  </td>
                  <td className="p-4 text-gray-500 dark:text-gray-400 font-mono text-sm break-all whitespace-normal min-w-[250px] max-w-[350px]">{check.target}</td>
                  <td className="p-4">
                    <div className="flex flex-col gap-1">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium w-fit ${
                        check.status === 'ok' ? 'bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400' :
                        check.status === 'fail' ? 'bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400' :
                        'bg-gray-100 dark:bg-gray-500/10 text-gray-700 dark:text-gray-400'
                      }`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          check.status === 'ok' ? 'bg-green-500 dark:bg-green-400' :
                          check.status === 'fail' ? 'bg-red-500 dark:bg-red-400' :
                          'bg-gray-500 dark:bg-gray-400'
                        }`} />
                        {check.status.toUpperCase()}
                      </span>
                      {/* Show error details if failed */}
                      {check.status === 'fail' && check.message && (
                          <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 p-1.5 rounded border border-red-100 dark:border-red-900/30 w-full max-w-[200px] break-words">
                              {check.message.replace('Error: ', '')}
                          </div>
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="flex items-end gap-0.5 h-8 w-32">
                        {check.history && check.history.length > 0 ? (
                            [...check.history].reverse().map((h, i) => (
                                <div 
                                    key={i}
                                    className={`w-1.5 rounded-t-sm ${
                                        h.status === 'ok' ? 'bg-green-500 dark:bg-green-400' : 'bg-red-500 dark:bg-red-400'
                                    }`}
                                    style={{ height: `${Math.min(100, Math.max(20, (h.latency || 0) / 2))}%` }}
                                    title={`${new Date(h.timestamp).toLocaleTimeString()} - ${h.status.toUpperCase()} (${h.latency}ms)`}
                                />
                            ))
                        ) : (
                            <span className="text-gray-400 text-xs">-</span>
                        )}
                    </div>
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex justify-end gap-2">
                        <button onClick={() => handleRun(check.id)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors" title="Run Now">
                            <Play className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleShowHistory(check)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 transition-colors" title="View History">
                            <History className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleOpenModal(check)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400 hover:text-yellow-600 dark:hover:text-yellow-400 transition-colors">
                            <Edit className="w-4 h-4" />
                        </button>
                        <button onClick={() => handleDelete(check.id)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors">
                            <Trash2 className="w-4 h-4" />
                        </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="xl:hidden divide-y divide-gray-200 dark:divide-gray-800">
                {filteredChecks.map(check => (
                    <div key={check.id} className="p-4 space-y-3">
                        <div className="flex justify-between items-start gap-2">
                            <div className="flex flex-col gap-2 min-w-0">
                                <span className="font-medium text-gray-900 dark:text-white break-words">{check.name}</span>
                                {check.status === 'fail' && check.message && (
                                    <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/10 p-2 rounded border border-red-100 dark:border-red-900/30 break-all">
                                        {check.message.replace('Error: ', '')}
                                    </div>
                                )}
                            </div>
                            <span className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                                check.status === 'ok' ? 'bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400' :
                                check.status === 'fail' ? 'bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400' :
                                'bg-gray-100 dark:bg-gray-500/10 text-gray-700 dark:text-gray-400'
                            }`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${
                                    check.status === 'ok' ? 'bg-green-500 dark:bg-green-400' :
                                    check.status === 'fail' ? 'bg-red-500 dark:bg-red-400' :
                                    'bg-gray-500 dark:bg-gray-400'
                                }`} />
                                {check.status.toUpperCase()}
                            </span>
                        </div>
                        
                        <div className="flex justify-between items-center gap-2 text-sm">
                             <span className="text-gray-500 dark:text-gray-400 font-mono break-all whitespace-normal flex-1">{check.target}</span>
                             <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[10px] text-gray-600 dark:text-gray-300 uppercase border border-gray-200 dark:border-gray-700 shrink-0">
                                {check.type}
                            </span>
                        </div>

                        <div className="flex justify-between items-center pt-1">
                            <div className="flex items-end gap-0.5 h-6 w-24">
                                {check.history && check.history.length > 0 ? (
                                    [...check.history].reverse().map((h, i) => (
                                        <div 
                                            key={i}
                                            className={`w-1.5 rounded-t-sm ${
                                                h.status === 'ok' ? 'bg-green-500 dark:bg-green-400' : 'bg-red-500 dark:bg-red-400'
                                            }`}
                                            style={{ height: `${Math.min(100, Math.max(20, (h.latency || 0) / 2))}%` }}
                                        />
                                    ))
                                ) : (
                                    <span className="text-gray-400 text-xs">-</span>
                                )}
                            </div>
                            
                            <div className="flex gap-1">
                                <button onClick={() => handleRun(check.id)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                                    <Play className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleShowHistory(check)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 transition-colors">
                                    <History className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleOpenModal(check)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400 hover:text-yellow-600 dark:hover:text-yellow-400 transition-colors">
                                    <Edit className="w-4 h-4" />
                                </button>
                                <button onClick={() => handleDelete(check.id)} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 transition-colors">
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
          </>
        )}
      </div>

      {/* History Modal */}
      {historyCheck && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-4xl border border-gray-200 dark:border-gray-800 flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-800">
              <div>
                <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                    History: {historyCheck.name}
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 font-mono">{historyCheck.target}</p>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                    {(['1h', '24h', '3d', '2w'] as const).map(range => (
                        <button
                            key={range}
                            onClick={() => setTimeRange(range)}
                            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                                timeRange === range 
                                    ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' 
                                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                            }`}
                        >
                            {range}
                        </button>
                    ))}
                </div>
                <button 
                    onClick={() => historyCheck && handleShowHistory(historyCheck)}
                    className="p-2 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                    title="Refresh History"
                >
                    <RefreshCw size={20} />
                </button>
                <button onClick={() => setHistoryCheck(null)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                    <X size={20} />
                </button>
              </div>
            </div>
            
            <div className="p-4 overflow-y-auto flex-1">
                {/* Chart */}
                <div className="h-64 mb-6 bg-gray-50 dark:bg-gray-800/50 rounded-lg p-4 relative">
                    {historyData.length > 0 ? (
                        (() => {
                            const now = new Date().getTime();
                            const ranges = {
                                '1h': 60 * 60 * 1000,
                                '24h': 24 * 60 * 60 * 1000,
                                '3d': 3 * 24 * 60 * 60 * 1000,
                                '2w': 14 * 24 * 60 * 60 * 1000
                            };
                            const rangeMs = ranges[timeRange];
                            const targetBuckets = 60;
                            const bucketSize = rangeMs / targetBuckets;

                            // Align the end time to the next bucket boundary to stabilize the graph
                            // This prevents the bars from "sliding" every second
                            const alignedEndTime = Math.ceil(now / bucketSize) * bucketSize;
                            const cutoff = alignedEndTime - rangeMs;
                            
                            // Filter data based on range
                            const filteredData = historyData.filter(h => new Date(h.timestamp).getTime() > cutoff);
                            
                            const buckets: { timestamp: number; latencySum: number; count: number; status: 'ok' | 'fail' }[] = [];
                            
                            // Initialize buckets
                            for (let i = 0; i < targetBuckets; i++) {
                                buckets.push({
                                    timestamp: cutoff + (i * bucketSize),
                                    latencySum: 0,
                                    count: 0,
                                    status: 'ok'
                                });
                            }

                            // Fill buckets
                            filteredData.forEach(h => {
                                const time = new Date(h.timestamp).getTime();
                                const bucketIndex = Math.floor((time - cutoff) / bucketSize);
                                if (bucketIndex >= 0 && bucketIndex < targetBuckets) {
                                    buckets[bucketIndex].latencySum += (h.latency || 0);
                                    buckets[bucketIndex].count++;
                                    if (h.status === 'fail') buckets[bucketIndex].status = 'fail';
                                }
                            });

                            // Convert to chart data
                            const chartData = buckets.map(b => ({
                                timestamp: new Date(b.timestamp).toISOString(),
                                latency: b.count > 0 ? Math.round(b.latencySum / b.count) : 0,
                                status: b.status,
                                hasData: b.count > 0
                            }));

                            const maxLatency = Math.max(...chartData.map(h => h.latency || 0), 100);

                            const formatLabel = (ts: number) => {
                                const d = new Date(ts);
                                if (timeRange === '1h' || timeRange === '24h') {
                                    return d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                                }
                                return d.toLocaleDateString([], {month: 'short', day: 'numeric'}) + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
                            };
                            
                            return (
                                <div className="w-full h-full flex flex-row">
                                    {/* Y-Axis */}
                                    <div className="flex flex-col justify-between text-[10px] text-gray-400 py-1 pr-2 text-right h-full pb-6 border-r border-gray-200 dark:border-gray-700 min-w-[50px]">
                                        <div className="flex flex-col items-end">
                                            <span className="font-medium text-gray-500 dark:text-gray-300 mb-1">Latency</span>
                                            <span>{maxLatency}ms</span>
                                        </div>
                                        <span>0ms</span>
                                    </div>

                                    <div className="flex-1 flex flex-col h-full pl-2">
                                        <div className="flex-1 flex items-end gap-0.5 relative">
                                            {chartData.map((h, i) => (
                                                <div 
                                                    key={i}
                                                    className={`flex-1 min-w-[2px] rounded-t-sm hover:opacity-80 transition-opacity relative group ${
                                                        !h.hasData ? 'bg-transparent' :
                                                        h.status === 'ok' ? 'bg-green-500 dark:bg-green-400' : 'bg-red-500 dark:bg-red-400'
                                                    }`}
                                                    style={{ height: h.hasData ? `${Math.max(5, ((h.latency || 0) / maxLatency) * 100)}%` : '0%' }}
                                                >
                                                    {h.hasData && (
                                                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-gray-900 text-white text-xs p-2 rounded whitespace-nowrap z-10 shadow-lg">
                                                            {new Date(h.timestamp).toLocaleString()}<br/>
                                                            Avg Latency: {h.latency}ms<br/>
                                                            Status: {h.status}
                                                        </div>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                        
                                        {/* X-Axis Labels */}
                                        <div className="flex justify-between text-[10px] text-gray-400 pt-2 border-t border-gray-200 dark:border-gray-700">
                                            <span>{formatLabel(cutoff)}</span>
                                            <span>{formatLabel(alignedEndTime)}</span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })()
                    ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400">
                            No history data available
                        </div>
                    )}
                </div>

                {/* Table */}
                <table className="w-full text-left text-sm">
                    <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 dark:text-gray-400 sticky top-0">
                        <tr>
                            <th className="p-3">Time</th>
                            <th className="p-3">Status</th>
                            <th className="p-3">Latency</th>
                            <th className="p-3">Message</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
                        {historyData.map((h, i) => (
                            <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                                <td className="p-3 text-gray-900 dark:text-white whitespace-nowrap">
                                    {new Date(h.timestamp).toLocaleString()}
                                </td>
                                <td className="p-3">
                                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                        h.status === 'ok' ? 'bg-green-100 dark:bg-green-500/10 text-green-700 dark:text-green-400' :
                                        'bg-red-100 dark:bg-red-500/10 text-red-700 dark:text-red-400'
                                    }`}>
                                        {h.status.toUpperCase()}
                                    </span>
                                </td>
                                <td className="p-3 text-gray-500 dark:text-gray-400 font-mono">
                                    {h.latency}ms
                                </td>
                                <td className="p-3 text-gray-500 dark:text-gray-400 truncate max-w-xs" title={h.message}>
                                    {h.message || '-'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
          </div>
        </div>
      )}

      {/* Edit/Create Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl w-full max-w-md border border-gray-200 dark:border-gray-800">
            <div className="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-800">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                {editingCheck ? 'Edit Check' : 'New Check'}
              </h3>
              <button onClick={() => setIsModalOpen(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                <X size={20} />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                <input 
                  type="text" 
                  value={formData.name}
                  onChange={e => setFormData({...formData, name: e.target.value})}
                  className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="e.g. Production API"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Type</label>
                <select 
                  value={formData.type}
                  onChange={e => setFormData({...formData, type: e.target.value as CheckType})}
                  className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="http">HTTP Request</option>
                  <option value="ping">Ping</option>
                  <option value="podman">Podman Container</option>
                  <option value="service">Managed Service</option>
                  <option value="systemd">System Service</option>
                  <option value="node">Remote Node Connection</option>
                  <option value="script">Custom Script (JS)</option>
                  <option value="fritzbox">Fritz!Box Internet</option>
                </select>
                
                {/* Type Hint */}
                <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 p-2 rounded border border-gray-200 dark:border-gray-700">
                    {formData.type === 'http' && (
                        <p>Checks an HTTP/HTTPS endpoint. Verifies the status code (default 200) and optionally the response body. Fails if the request times out or returns an unexpected status.</p>
                    )}
                    {formData.type === 'ping' && (
                        <p>Sends ICMP Echo Requests (ping) to the target host. Verifies network reachability. Fails if the host is unreachable or packet loss occurs.</p>
                    )}
                    {formData.type === 'podman' && (
                        <p>Inspects a specific Podman container. Verifies that the container state is &apos;running&apos; and (if configured) the health check status is &apos;healthy&apos;. Fails if the container is stopped or unhealthy.</p>
                    )}
                    {formData.type === 'service' && (
                        <p>Checks a systemd user service (managed by ServiceBay). Verifies that the unit is &apos;active&apos;. Fails if the service is inactive, failed, or not found.</p>
                    )}
                    {formData.type === 'systemd' && (
                        <p>Checks a system-wide systemd unit (e.g., sshd, docker). Verifies that the unit is &apos;active&apos;. Fails if the unit is inactive or failed.</p>
                    )}
                    {formData.type === 'node' && (
                        <p>Verifies the connection to a remote Podman node. Checks SSH connectivity and the Podman socket availability. Fails if the node is unreachable or Podman is not responding.</p>
                    )}
                    {formData.type === 'script' && (
                        <p>Executes a custom JavaScript snippet in a sandboxed environment. Use <code>fetch()</code> for custom logic. Throw an error to fail the check.</p>
                    )}
                    {formData.type === 'fritzbox' && (
                        <p>Queries a Fritz!Box router via UPnP (TR-064) to check internet connectivity status. Fails if the router reports &apos;Disconnected&apos; or is unreachable.</p>
                    )}
                </div>
              </div>
              {formData.type !== 'node' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Target Node</label>
                <select 
                  value={formData.nodeName || ''}
                  onChange={e => setFormData({...formData, nodeName: e.target.value})}
                  className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="">Local (ServiceBay Host)</option>
                  {nodes.map(node => (
                    <option key={node.Name} value={node.Name}>{node.Name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Select the node where this check should run.</p>
              </div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {formData.type === 'script' ? 'Script Content' : formData.type === 'fritzbox' ? 'Fritz!Box Hostname / IP' : formData.type === 'node' ? 'Node Name' : 'Target'}
                </label>
                {formData.type === 'script' ? (
                    <textarea
                        value={formData.target}
                        onChange={e => setFormData({...formData, target: e.target.value})}
                        className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm h-32"
                        placeholder="if (1 !== 1) throw new Error('Math broken')"
                    />
                ) : formData.type === 'podman' ? (
                    <div className="relative">
                        <select
                            value={formData.target}
                            onChange={e => setFormData({...formData, target: e.target.value})}
                            disabled={resourcesLoading}
                            className={`w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none ${resourcesLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                            <option value="">{resourcesLoading ? 'Loading containers...' : 'Select a container...'}</option>
                            {!resourcesLoading && containers.map((c) => (
                                <option key={c.Id} value={c.Names[0]}>
                                    {c.Names[0]} ({c.Image})
                                </option>
                            ))}
                        </select>
                        {resourcesLoading && (
                            <div className="absolute right-8 top-2.5">
                                <div className="animate-spin h-5 w-5 border-2 border-blue-500 rounded-full border-t-transparent"></div>
                            </div>
                        )}
                    </div>
                ) : formData.type === 'service' ? (
                    <Autocomplete
                        options={managedServices}
                        value={formData.target || ''}
                        onChange={val => setFormData({...formData, target: val})}
                        placeholder="Select a managed service..."
                        loading={resourcesLoading}
                        disabled={resourcesLoading}
                    />
                ) : formData.type === 'systemd' ? (
                    <Autocomplete
                        options={systemServices}
                        value={formData.target || ''}
                        onChange={val => setFormData({...formData, target: val})}
                        placeholder="Search system services..."
                        loading={resourcesLoading}
                        disabled={resourcesLoading}
                    />
                ) : formData.type === 'node' ? (
                    <select
                        value={formData.target}
                        onChange={e => setFormData({...formData, target: e.target.value})}
                        className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                        <option value="">Select a node...</option>
                        {nodes.map((n) => (
                            <option key={n.Name} value={n.Name}>
                                {n.Name} ({n.URI})
                            </option>
                        ))}
                    </select>
                ) : (
                    <input 
                      type="text" 
                      value={formData.target}
                      onChange={e => setFormData({...formData, target: e.target.value})}
                      className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                      placeholder={
                        formData.type === 'http' ? 'https://example.com' : 
                        formData.type === 'fritzbox' ? 'fritz.box' :
                        '192.168.1.1'
                      }
                    />
                )}
              </div>

              {formData.type === 'fritzbox' && (
                <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800 text-sm text-blue-800 dark:text-blue-200">
                    <p className="font-medium mb-1">Configuration Note</p>
                    <p className="text-xs opacity-80">Ensure &quot;Status information over UPnP&quot; is enabled in your Fritz!Box settings (Home Network &gt; Network &gt; Network Settings).</p>
                </div>
              )}

              {formData.type === 'http' && (
                <div className="space-y-4 p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-200 dark:border-gray-700">
                    <h4 className="text-sm font-medium text-gray-900 dark:text-white">HTTP Options</h4>
                    <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Expected Status Code</label>
                        <input 
                            type="number" 
                            value={formData.httpConfig?.expectedStatus || 200}
                            onChange={e => setFormData({
                                ...formData, 
                                httpConfig: { ...formData.httpConfig, expectedStatus: parseInt(e.target.value) }
                            })}
                            className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Body Match (Optional)</label>
                        <div className="flex gap-2 mb-2">
                            <select
                                value={formData.httpConfig?.bodyMatchType || 'contains'}
                                onChange={e => setFormData({
                                    ...formData, 
                                    httpConfig: { ...formData.httpConfig, bodyMatchType: e.target.value as 'contains' | 'regex' }
                                })}
                                className="p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                            >
                                <option value="contains">Contains</option>
                                <option value="regex">Regex</option>
                            </select>
                            <input 
                                type="text" 
                                value={formData.httpConfig?.bodyMatch || ''}
                                onChange={e => setFormData({
                                    ...formData, 
                                    httpConfig: { ...formData.httpConfig, bodyMatch: e.target.value }
                                })}
                                className="flex-1 p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                                placeholder={formData.httpConfig?.bodyMatchType === 'regex' ? '^Hello.*World$' : 'Success'}
                            />
                        </div>
                    </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Interval (seconds)</label>
                <input 
                  type="number" 
                  value={formData.interval}
                  onChange={e => setFormData({...formData, interval: parseInt(e.target.value)})}
                  className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                  min="10"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 rounded-b-xl">
              <button 
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleSave}
                className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors font-medium"
              >
                Save Check
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        isOpen={isDeleteModalOpen}
        title="Delete Check"
        message="Are you sure you want to delete this monitoring check? This action cannot be undone."
        confirmText="Delete"
        isDestructive={true}
        onConfirm={confirmDelete}
        onCancel={() => setIsDeleteModalOpen(false)}
      />
      </div>
    </div>
  );
}
