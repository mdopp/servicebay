'use client';

import { useState, useEffect } from 'react';
import { getSystemUpdates } from '@/app/actions/system';
import { RefreshCw, CheckCircle, AlertTriangle, Download, Package, Clock, Server } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

interface AppUpdateStatus {
  hasUpdate: boolean;
  current: string;
  latest: {
    version: string;
    url: string;
    date: string;
    notes: string;
  } | null;
  config: {
    autoUpdate: {
      enabled: boolean;
      schedule: string;
    }
  };
}

export default function UpdatesPlugin() {
  const [updates, setUpdates] = useState<{ count: number; list: string[] } | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const { addToast } = useToast();

  const fetchData = async () => {
    setLoading(true);
    try {
      const [sysData, appData] = await Promise.all([
        getSystemUpdates(),
        fetch('/api/system/update').then(r => r.json())
      ]);
      setUpdates(sysData);
      setAppUpdate(appData);
    } catch (error) {
      console.error('Failed to fetch updates', error);
    } finally {
      setLoading(false);
    }
  };

  const handleAppUpdate = async () => {
    if (!appUpdate?.latest) return;
    if (!confirm(`Update ServiceBay to ${appUpdate.latest.version}? The service will restart.`)) return;
    
    setUpdating(true);
    try {
      const res = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', version: appUpdate.latest.version })
      });
      
      if (res.ok) {
        addToast('success', 'Update started', 'Service is restarting. Please reload the page in a few seconds.');
      } else {
        throw new Error('Update failed');
      }
    } catch {
      addToast('error', 'Update failed', 'Could not start update process.');
    } finally {
      setUpdating(false);
    }
  };

  const toggleAutoUpdate = async () => {
    if (!appUpdate) return;
    const newState = !appUpdate.config.autoUpdate.enabled;
    
    try {
      const res = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
            action: 'configure', 
            autoUpdate: { enabled: newState } 
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        setAppUpdate(prev => prev ? { ...prev, config: data.config } : null);
        addToast('success', 'Settings saved', `Auto-update ${newState ? 'enabled' : 'disabled'}.`);
      }
    } catch {
      addToast('error', 'Error', 'Failed to save settings.');
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  return (
    <div className="h-full flex flex-col">
      <div className="flex justify-between items-center mb-6 p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Updates Center</h2>
        <button onClick={fetchData} className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" title="Refresh">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* App Update Section */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Package size={20} /> ServiceBay Application
            </h3>
            
            {loading && !appUpdate ? (
                <div className="text-gray-500">Checking app version...</div>
            ) : appUpdate ? (
                <div className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm text-gray-500">Current Version</p>
                            <p className="font-mono font-medium">{appUpdate.current}</p>
                        </div>
                        {appUpdate.latest && (
                            <div className="text-right">
                                <p className="text-sm text-gray-500">Latest Version</p>
                                <p className="font-mono font-medium text-blue-600 dark:text-blue-400">{appUpdate.latest.version}</p>
                            </div>
                        )}
                    </div>

                    {appUpdate.latest ? (
                        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800 rounded p-4">
                            <div className="flex items-start gap-3">
                                <Download className="text-blue-600 dark:text-blue-400 mt-1" size={20} />
                                <div className="flex-1">
                                    <h4 className="font-medium text-blue-900 dark:text-blue-100">Update Available</h4>
                                    <p className="text-sm text-blue-700 dark:text-blue-300 mt-1 mb-3">
                                        A new version is available. 
                                        {appUpdate.latest.date && ` Released on ${new Date(appUpdate.latest.date).toLocaleDateString()}.`}
                                    </p>
                                    <button 
                                        onClick={handleAppUpdate}
                                        disabled={updating}
                                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                    >
                                        {updating ? <RefreshCw className="animate-spin" size={16} /> : <Download size={16} />}
                                        {updating ? 'Updating...' : 'Install Update'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="flex items-center gap-2 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/10 p-3 rounded border border-green-100 dark:border-green-900/20">
                            <CheckCircle size={18} />
                            <span className="font-medium">You are using the latest version</span>
                        </div>
                    )}

                    <div className="pt-4 border-t border-gray-100 dark:border-gray-800 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Clock size={18} className="text-gray-400" />
                            <span className="text-sm font-medium">Auto-Update</span>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                            <input 
                                type="checkbox" 
                                className="sr-only peer"
                                checked={appUpdate.config.autoUpdate.enabled}
                                onChange={toggleAutoUpdate}
                            />
                            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                        </label>
                    </div>
                </div>
            ) : (
                <div className="text-red-500">Failed to load app info.</div>
            )}
        </div>

        {/* System Update Section */}
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-6 shadow-sm">
            <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Server size={20} /> System Updates
            </h3>
        
        {loading && !updates ? (
            <div className="text-center text-gray-500 py-4">Checking system updates...</div>
        ) : !updates ? (
            <div className="text-center text-red-500 py-4">Failed to check system updates.</div>
        ) : updates.count === 0 ? (
            <div className="flex items-center gap-2 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/10 p-3 rounded border border-green-100 dark:border-green-900/20">
                <CheckCircle size={18} />
                <span className="font-medium">System is up to date</span>
            </div>
        ) : (
            <div>
                <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 mb-6 flex items-center gap-3">
                    <AlertTriangle className="text-yellow-600 dark:text-yellow-400" size={24} />
                    <div>
                        <h3 className="font-bold text-yellow-800 dark:text-yellow-200">{updates.count} Updates Available</h3>
                        <p className="text-sm text-yellow-700 dark:text-yellow-300">Security patches and software updates are waiting.</p>
                    </div>
                </div>

                <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden mb-4">
                    <div className="p-2 px-3 border-b border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Packages
                    </div>
                    <ul className="divide-y divide-gray-200 dark:divide-gray-700 max-h-40 overflow-y-auto">
                        {updates.list.map((pkg, i) => (
                            <li key={i} className="p-2 px-3 text-sm font-mono text-gray-700 dark:text-gray-300">
                                {pkg}
                            </li>
                        ))}
                    </ul>
                </div>
                
                <div className="text-center">
                    <p className="text-sm text-gray-500 mb-2">To install system updates, run this in your terminal:</p>
                    <code className="bg-gray-100 dark:bg-gray-800 px-3 py-2 rounded text-sm font-mono block w-full overflow-x-auto">
                        sudo apt update && sudo apt upgrade
                    </code>
                </div>
            </div>
        )}
        </div>
      </div>
    </div>
  );
}
