'use client';

import { useState, useEffect } from 'react';
import { Trash2, Plus, HardDrive, RefreshCw, X } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import PluginHelp from './PluginHelp';

interface Volume {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Labels: Record<string, string>;
  Options: Record<string, string>;
  Scope: string;
  Node?: string;
  UsedBy: { id: string; name: string }[];
  Anonymous?: boolean;
}

export default function VolumeList() {
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [showAnonymous, setShowAnonymous] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newVolName, setNewVolName] = useState('');
  const [newVolPath, setNewVolPath] = useState('');
  const [creating, setCreating] = useState(false);
  
  const { addToast, updateToast } = useToast();
  // We ignore searchParams node for displaying ALL volumes, unless specifically filtering.
  // Actually, let's just fetch all by default.
  // const searchParams = useSearchParams();
  // const node = searchParams?.get('node'); 
  const node = null; // Force fetch all
   
  const fetchVolumes = async () => {
    if (volumes.length === 0) setLoading(true);
    setRefreshing(true);
    
    // Start toast if not initial load
    let toastId: string | null = null;
    if (volumes.length > 0) {
       toastId = addToast('loading', 'Refreshing Volumes', 'Fetching latest data...', 0);
    }

    try {
      // Calling without node param fetches all nodes
      const res = await fetch(`/api/volumes`); 
      if (!res.ok) throw new Error('Failed to fetch volumes');
      const data = await res.json();
      setVolumes(data);
      
      if (toastId) updateToast(toastId, 'success', 'Volumes Updated', 'Volume list refreshed');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load volumes';
      if (toastId) updateToast(toastId, 'error', 'Refresh Failed', msg);
      else addToast('error', msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchVolumes(); // Only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Remove dependency on node, as we always want ALL volumes on this page

  const handleDelete = async (name: string, volumeNode?: string) => {
    if (!confirm(`Are you sure you want to delete volume ${name}?`)) return;
    try {
      // Must pass node to delete correct volume
      const query = volumeNode ? `?node=${volumeNode}` : '';
      const res = await fetch(`/api/volumes/${name}${query}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete');
      }
      addToast('success', 'Volume deleted');
      fetchVolumes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      addToast('error', e.message);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVolName) return;
    
    setCreating(true);
    try {
        const options: Record<string, string> = {};
        if (newVolPath) {
            options.type = 'none';
            options.o = 'bind';
            options.device = newVolPath;
        }

        const res = await fetch('/api/volumes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: newVolName,
                options: Object.keys(options).length > 0 ? options : undefined,
                node
            })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'Failed to create volume');
        }

        addToast('success', 'Volume created');
        setIsCreateOpen(false);
        setNewVolName('');
        setNewVolPath('');
        fetchVolumes();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
        addToast('error', e.message);
    } finally {
        setCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-900">
        <div className="p-6 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center shrink-0">
            <h2 className="text-2xl font-bold flex items-center gap-2 text-gray-900 dark:text-gray-100">
                <HardDrive className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                Volumes
            </h2>
            <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none">
                    <input 
                        type="checkbox" 
                        checked={showAnonymous} 
                        onChange={e => setShowAnonymous(e.target.checked)}
                        className="rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500 bg-gray-50 dark:bg-gray-800"
                    />
                    Show System
                </label>
                <PluginHelp helpId="volumes" />
                <button 
                    onClick={fetchVolumes} 
                    disabled={refreshing}
                    className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 transition-colors"
                    title="Refresh"
                >
                    <RefreshCw size={20} className={refreshing ? 'animate-spin' : ''} />
                </button>
                <button 
                    onClick={() => setIsCreateOpen(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors font-medium shadow-sm"
                >
                    <Plus size={18} />
                    <span>Create</span>
                </button>
            </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
            <div className="flex justify-center p-8">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
        ) : (
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
            <table className="w-full text-left">
                <thead className="bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Name</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Used By</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Driver</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Mountpoint</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {volumes.filter(vol => showAnonymous || !vol.Anonymous).map(vol => (
                <tr key={`${vol.Node}-${vol.Name}`} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <td className="p-4">
                      <div className="flex flex-col">
                        <span className="font-medium text-gray-900 dark:text-gray-100">{vol.Name}</span>
                        {vol.Node && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200 w-fit mt-0.5 border border-blue-200 dark:border-blue-800">
                                {vol.Node}
                            </span>
                        )}
                      </div>
                  </td>
                  <td className="p-4">
                    {vol.UsedBy && vol.UsedBy.length > 0 ? (
                        <div className="flex flex-col gap-1">
                            {vol.UsedBy.map(c => (
                                <span key={c.id} className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-600" title={`ID: ${c.id}`}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 mr-1.5"></span>
                                    {c.name}
                                </span>
                            ))}
                        </div>
                    ) : (
                        <span className="text-xs text-gray-400 italic">Unused</span>
                    )}
                  </td>
                  <td className="p-4 text-sm text-gray-500 dark:text-gray-400">{vol.Driver}</td>
                  <td className="p-4 text-sm font-mono text-gray-500 dark:text-gray-400 truncate max-w-xs" title={vol.Mountpoint}>
                    {vol.Mountpoint}
                  </td>
                  <td className="p-4">
                    <button 
                        onClick={() => handleDelete(vol.Name, vol.Node)}
                        className="text-red-500 hover:text-red-700 dark:hover:text-red-400 transition-colors p-1 hover:bg-red-50 dark:hover:bg-red-900/20 rounded"
                        title="Delete Volume"
                    >
                        <Trash2 size={18} />
                    </button>
                  </td>
                </tr>
              ))}
              {volumes.length === 0 && (
                <tr>
                    <td colSpan={4} className="p-8 text-center text-gray-500 dark:text-gray-400">No volumes found</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>

      {isCreateOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-md p-6">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">Create Volume</h3>
                    <button onClick={() => setIsCreateOpen(false)} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300">
                        <X size={24} />
                    </button>
                </div>
                <form onSubmit={handleCreate} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Volume Name
                        </label>
                        <input 
                            type="text" 
                            value={newVolName}
                            onChange={e => setNewVolName(e.target.value)}
                            className="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                            placeholder="my-volume"
                            required
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Host Path (Optional)
                        </label>
                        <input 
                            type="text" 
                            value={newVolPath}
                            onChange={e => setNewVolPath(e.target.value)}
                            className="w-full p-2 border rounded-md dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                            placeholder="/path/on/host"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                            Leave empty for a standard managed volume.
                        </p>
                    </div>
                    <div className="flex justify-end gap-2 mt-6">
                        <button 
                            type="button"
                            onClick={() => setIsCreateOpen(false)}
                            className="px-4 py-2 text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 rounded-md"
                        >
                            Cancel
                        </button>
                        <button 
                            type="submit"
                            disabled={creating}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md disabled:opacity-50"
                        >
                            {creating ? 'Creating...' : 'Create'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
      )}
    </div>
  );
}
