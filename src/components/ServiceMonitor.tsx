'use client';

import { useState, useEffect } from 'react';
import { RefreshCw, Terminal, Activity, Box, ArrowLeft, Network } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import ContainerList from './ContainerList';

interface ServiceMonitorProps {
  serviceName: string;
}

export default function ServiceMonitor({ serviceName }: ServiceMonitorProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const node = searchParams?.get('node');
  const [activeTab, setActiveTab] = useState<'status' | 'service' | 'container-logs' | 'network'>('status');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [logs, setLogs] = useState<{ serviceLogs: string; podmanPs: any[] } | null>(null);
  const [status, setStatus] = useState<string>('');
  const [containerLogs, setContainerLogs] = useState<string>('');
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [networkData, setNetworkData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const fetchLogs = async () => {
    setLoading(true);
    try {
      const query = node ? `?node=${node}` : '';
      const [logsRes, statusRes, graphRes] = await Promise.all([
        fetch(`/api/services/${serviceName}/logs${query}`),
        fetch(`/api/services/${serviceName}/status${query}`),
        fetch(`/api/network/graph${query}`)
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
      if (graphRes.ok) {
          const graph = await graphRes.json();
          // Find the node corresponding to this service
          // 1. Check for Proxy
          if (serviceName === 'Reverse Proxy' || serviceName === 'nginx' || serviceName === 'nginx-web') {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const proxyNode = graph.nodes.find((n: any) => n.type === 'proxy' && (node ? n.node === node : true));
              if (proxyNode) setNetworkData(proxyNode);
          } else {
              // 2. Check for Service
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const serviceNode = graph.nodes.find((n: any) => 
                  ((n.type === 'service' && n.label === serviceName) ||
                  (n.type === 'container' && n.label.includes(serviceName))) &&
                  (node ? n.node === node : true)
              );
              if (serviceNode) setNetworkData(serviceNode);
          }
      }
    } catch (e) {
      console.error('Failed to fetch data', e);
    } finally {
      setLoading(false);
    }
  };

  const fetchContainerLogs = async (id: string) => {
    try {
        const query = node ? `?node=${node}` : '';
        const res = await fetch(`/api/containers/${id}/logs${query}`);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      <div className="flex-1 flex flex-col min-h-0 p-6">
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col flex-1 min-h-0">
        <div className="flex border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 shrink-0">
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
            <button
            className={`px-6 py-3 font-medium text-sm flex items-center gap-2 transition-colors ${activeTab === 'network' ? 'bg-white dark:bg-gray-900 text-blue-600 dark:text-blue-400 border-t-2 border-t-blue-600 dark:border-t-blue-400' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
            onClick={() => setActiveTab('network')}
            >
            <Network size={16} /> Network & Raw Data
            </button>
        </div>

        <div className="bg-[#2d2d2d] dark:bg-black p-4 flex-1 overflow-y-auto">
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
            {activeTab === 'network' && (
                <div className="space-y-6">
                    {networkData ? (
                        <>
                            {/* Network Details */}
                            <div className="bg-gray-900 p-4 rounded border border-gray-800">
                                <h3 className="text-gray-400 text-sm font-bold mb-4 uppercase tracking-wider">Network Details</h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                    <div className="flex justify-between border-b border-gray-800 pb-2">
                                        <span className="text-gray-500">Node ID</span>
                                        <span className="font-mono text-gray-300">{networkData.id}</span>
                                    </div>
                                    <div className="flex justify-between border-b border-gray-800 pb-2">
                                        <span className="text-gray-500">Type</span>
                                        <span className="font-mono text-gray-300">{networkData.type}</span>
                                    </div>
                                    <div className="flex justify-between border-b border-gray-800 pb-2">
                                        <span className="text-gray-500">Status</span>
                                        <span className={`font-mono ${networkData.status === 'up' ? 'text-green-400' : 'text-red-400'}`}>
                                            {networkData.status?.toUpperCase()}
                                        </span>
                                    </div>
                                    {networkData.ip && (
                                        <div className="flex justify-between border-b border-gray-800 pb-2">
                                            <span className="text-gray-500">IP Address</span>
                                            <span className="font-mono text-gray-300">{networkData.ip}</span>
                                        </div>
                                    )}
                                    {networkData.ports && networkData.ports.length > 0 && (
                                        <div className="flex justify-between border-b border-gray-800 pb-2">
                                            <span className="text-gray-500">Ports</span>
                                            <span className="font-mono text-gray-300">
                                                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                                                {networkData.ports.map((p: any) => {
                                                    if (typeof p === 'object') {
                                                        const h = p.host || p.host_port;
                                                        const c = p.container || p.container_port;
                                                        return h && c && h !== c ? `${h}:${c}` : (h || c);
                                                    }
                                                    return p;
                                                }).join(', ')}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Raw Data */}
                            <div className="bg-gray-900 p-4 rounded border border-gray-800">
                                <h3 className="text-gray-400 text-sm font-bold mb-4 uppercase tracking-wider">Raw Data / Config</h3>
                                <pre className="text-xs font-mono text-gray-400 whitespace-pre-wrap break-all bg-black p-4 rounded border border-gray-800">
                                    {JSON.stringify(networkData.rawData, null, 2)}
                                </pre>
                            </div>
                        </>
                    ) : (
                        <div className="text-gray-400 italic">No network data found for this service.</div>
                    )}
                </div>
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

