'use client';

import { useState, useEffect } from 'react';
import { Trash2, Plus, HardDrive, RefreshCw, X } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { useSearchParams } from 'next/navigation';

interface Volume {
  Name: string;
  Driver: string;
  Mountpoint: string;
  Labels: Record<string, string>;
  Options: Record<string, string>;
  Scope: string;
}

export default function VolumeList() {
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newVolName, setNewVolName] = useState('');
  const [newVolPath, setNewVolPath] = useState('');
  const [creating, setCreating] = useState(false);
  
  const { addToast } = useToast();
  const searchParams = useSearchParams();
  const node = searchParams?.get('node');

  const fetchVolumes = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/volumes${node ? `?node=${node}` : ''}`);
      if (!res.ok) throw new Error('Failed to fetch volumes');
      const data = await res.json();
      setVolumes(data);
    } catch (_e) {
      addToast('error', 'Failed to load volumes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVolumes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);

  const handleDelete = async (name: string) => {
    if (!confirm(`Are you sure you want to delete volume ${name}?`)) return;
    try {
      const res = await fetch(`/api/volumes/${name}${node ? `?node=${node}` : ''}`, { method: 'DELETE' });
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
    <div className="space-y-4 p-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold flex items-center gap-2 text-gray-800 dark:text-gray-100">
          <HardDrive className="w-6 h-6" />
          Volumes
        </h2>
        <div className="flex gap-2">
            <button 
                onClick={() => setIsCreateOpen(true)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors"
            >
                <Plus size={20} />
                <span>Create Volume</span>
            </button>
            <button onClick={fetchVolumes} className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md text-gray-600 dark:text-gray-300">
                <RefreshCw size={20} />
            </button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center p-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden border border-gray-200 dark:border-gray-700">
          <table className="w-full text-left">
            <thead className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
              <tr>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Name</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Driver</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Mountpoint</th>
                <th className="p-4 text-sm font-semibold text-gray-600 dark:text-gray-300">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {volumes.map(vol => (
                <tr key={vol.Name} className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                  <td className="p-4 font-medium text-gray-900 dark:text-gray-100">{vol.Name}</td>
                  <td className="p-4 text-sm text-gray-500 dark:text-gray-400">{vol.Driver}</td>
                  <td className="p-4 text-sm font-mono text-gray-500 dark:text-gray-400 truncate max-w-xs" title={vol.Mountpoint}>
                    {vol.Mountpoint}
                  </td>
                  <td className="p-4">
                    <button 
                        onClick={() => handleDelete(vol.Name)}
                        className="text-red-500 hover:text-red-700 dark:hover:text-red-400 transition-colors"
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
