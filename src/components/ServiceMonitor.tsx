'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, Terminal, Activity, Box, ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import ContainerList from './ContainerList';

interface ServiceMonitorProps {
  serviceName: string;
}

export default function ServiceMonitor({ serviceName }: ServiceMonitorProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<'status' | 'service' | 'container-logs'>('status');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [logs, setLogs] = useState<{ serviceLogs: string; podmanPs: any[] } | null>(null);
  const [status, setStatus] = useState<string>('');
  const [containerLogs, setContainerLogs] = useState<string>('');
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const [logsRes, statusRes] = await Promise.all([
        fetch(`/api/services/${serviceName}/logs`),
        fetch(`/api/services/${serviceName}/status`)
      ]);

      if (logsRes.ok) {
        const data = await logsRes.json();
        // Filter containers relevant to this service
        // We assume the service name is part of the container name or pod name
        // Quadlet usually names containers like "systemd-<service>" or just uses the name from .container
        // We'll try to match loosely
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const filteredPs = data.podmanPs.filter((c: any) => {
            const names = Array.isArray(c.Names) ? c.Names : [c.Names];
            return names.some((n: string) => n.includes(serviceName));
        });
        
        setLogs({ ...data, podmanPs: filteredPs });
        
        if (filteredPs.length > 0 && !selectedContainerId) {
            setSelectedContainerId(filteredPs[0].Id);
        }
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        setStatus(data.status);
      }
    } catch (e) {
      console.error('Failed to fetch data', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchContainerLogs = async (id: string) => {
    try {
        const res = await fetch(`/api/containers/${id}/logs`);
        if (res.ok) {
            const data = await res.json();
            setContainerLogs(data.logs);
        }
    } catch (e) {
        console.error('Failed to fetch container logs', e);
    }
  };

  useEffect(() => {
    fetchLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceName]);

  useEffect(() => {
    if (activeTab === 'container-logs' && selectedContainerId) {
        fetchContainerLogs(selectedContainerId);
    }
  }, [activeTab, selectedContainerId]);

  return (
    <div className="h-full flex flex-col relative">
      <div className="flex justify-between items-center mb-6 p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <div className="flex items-center gap-4">
            <button onClick={() => router.back()} className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors">
                <ArrowLeft size={24} className="text-gray-600 dark:text-gray-300" />
            </button>
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Monitor: {serviceName}</h1>
        </div>
        <div className="flex gap-3">
            <button 
                onClick={fetchLogs} 
                disabled={loading}
                className="p-2 text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors" 
                title="Refresh"
            >
                <RefreshCw size={20} className={loading ? 'animate-spin' : ''} />
            </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden">
        <div className="flex border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
            <button
            className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'status' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
            onClick={() => setActiveTab('status')}
            >
            <Activity size={16} /> Status
            </button>
            <button
            className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'service' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
            onClick={() => setActiveTab('service')}
            >
            <Terminal size={16} /> Service Logs
            </button>
            <button
            className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'container-logs' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
            onClick={() => setActiveTab('container-logs')}
            >
            <Box size={16} /> Container Logs & Info
            </button>
        </div>

        <div className="bg-[#2d2d2d] dark:bg-black p-4 min-h-[500px] max-h-[800px] overflow-y-auto">
            {activeTab === 'status' && (
            <pre className="text-sm font-mono text-green-400 whitespace-pre-wrap">
                {status || 'Loading status...'}
            </pre>
            )}
            {activeTab === 'service' && (
            <pre className="text-sm font-mono text-gray-300 whitespace-pre-wrap">
                {logs?.serviceLogs || 'No logs available.'}
            </pre>
            )}
            {activeTab === 'container-logs' && (
                <div className="space-y-4">
                    {logs?.podmanPs && logs.podmanPs.length > 0 ? (
                        <>
                            <div className="mb-4">
                                <h4 className="text-gray-400 text-sm font-bold mb-2">Related Containers</h4>
                                <ContainerList containers={logs.podmanPs} />
                            </div>
                            
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-gray-400 text-sm font-bold">Container Logs</h4>
                                    <select 
                                        className="bg-gray-700 text-white text-sm rounded border border-gray-600 p-1"
                                        value={selectedContainerId || ''}
                                        onChange={(e) => setSelectedContainerId(e.target.value)}
                                    >
                                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                                        {logs.podmanPs.map((c: any) => (
                                            <option key={c.Id} value={c.Id}>
                                                {Array.isArray(c.Names) ? c.Names[0] : c.Names} ({c.Id.substring(0, 12)})
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <pre className="text-sm font-mono text-gray-300 whitespace-pre-wrap bg-black p-4 rounded border border-gray-700 min-h-[300px]">
                                    {containerLogs || 'Select a container to view logs.'}
                                </pre>
                            </div>
                        </>
                    ) : (
                        <div className="text-gray-400 italic">No running containers found matching this service.</div>
                    )}
                </div>
            )}
        </div>
      </div>
      </div>
    </div>
  );
}

